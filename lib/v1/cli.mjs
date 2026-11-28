import {validateRunRequest,borrowerRunRequest} from './run-request.mjs';
import { waitingSummary } from './status-contract.mjs';
import {launchFenceLine} from './lending-status-copy.mjs';
import {validateWorkingDirectory} from '../working-directory.mjs';
// Shared v1 borrower operations. No runner, provider calls, or v0 state changes.
import {prepareFollowup,checkFollowup} from './followup.mjs';
import {jobWatchRevision} from './job-watch.mjs';
import { randomUUID } from 'node:crypto';
import { HARNESS_ADAPTERS } from '../harnesses/index.mjs';
import { readFile, lstat, readdir, mkdir, mkdtemp, writeFile, rm, open, stat } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { buildSourceManifest } from '../source-manifest.mjs';
import { filterSourceArchive } from '../source-filter.mjs';
import { sourceOmissionLines } from './secret-files.mjs';
import { packageSourceDirectory } from '../source-package.mjs';
import { extractArchive, validateArchive } from '../archive.mjs';
import * as p from '../protocol/index.mjs';
import { RESULT_KINDS } from '../protocol/index.mjs';
import { RUN_REQUEST_CAPABILITY, DESIGNATED_MEMBER_CAPABILITY } from './versions.mjs';
import { finalMessage } from './result-output.mjs';
import { openDevice } from './device.mjs';
import { DOCKER_SIGNED_OUT_MESSAGE } from './docker-state.mjs';
import { readLendingLog } from './lending-log.mjs';
import { configHome } from '../local-state.mjs';
import {withProfileWriter} from './lock.mjs';
import { classifyJobId, isFullDigest, matchPrefix, shortId, MIN_PREFIX_LENGTH } from './job-id.mjs';
import { helpFor, wantsHelp } from './help.mjs';
import { createJobMetaStore, cleanTitle } from './job-meta.mjs';
import { classify, FAILURE_CODES } from './failures.mjs';
import { jobSendEffect } from './ops/registry.mjs';
import { jobCircles, resolveJobRecipient } from './job-recipient.mjs';
// The app's default job circle is the lend circle, read from the settings file the app writes. Missing settings mean none.
const lendingCircleOf = home => { try { return JSON.parse(readFileSync(join(resolve(home), 'v1', 'app-settings.json'), 'utf8')).activeCircle ?? null; } catch { return null; } };
const defaultJobCircles = (device, home) => jobCircles(device, {lendingCircle: lendingCircleOf(home)});
import {projectMembership} from './membership-projection.mjs';
import {JOB_DEFAULTS} from './job-defaults.mjs';
import {jobStatusLabel, observedExecutionTime, createJobProjection, adaptLegacyJob} from './state-projection.mjs';
import {outcomeFields} from './outcome.mjs';
import {classifyHostFailure, CIRCLE_UNREACHABLE} from './host-failure.mjs';
export {JOB_DEFAULTS} from './job-defaults.mjs';

export class UsageError extends Error {
  constructor(message) { super(message); this.code = 'invalid_request'; this.name = 'UsageError'; }
}
const MESSAGE_FILE='message.md';
const SOURCE_CHOICE='Choose exactly one source: --source, --git or --no-source.';
const NO_SOURCE=Object.freeze({kind:'none'});
// The host's final job states. Before one of them a job may still run, so the same ask must not start a second.
const FINISHED_JOB_STATES=new Set(['result-accepted','failed','expired','cancelled']);
// A job the host no longer knows has finished. One whose state cannot be read is treated as still running.
async function mayStillRun(client,jobDigest,signal) {
  // A cancelled job whose compute has not stopped is still running (the app's "Stopping"); it is finished only when it stops.
  try { const job=await client.getJob(jobDigest,{signal}); return !FINISHED_JOB_STATES.has(job.state)||statusLabel(job)==='Stopping'; }
  catch(error) { if(signal?.aborted)throw error; return error?.status!==404; }
}
/** The signed `result` for a requested kind, or null for code changes (absent or branch: the legacy job). */
function requestedResult(input) {
  if(input.result===undefined) return null;
  const result=input.result;
  if(!result||typeof result!=='object'||Array.isArray(result)||Object.keys(result).join()!=='kind'||!RESULT_KINDS.includes(result.kind))
    usage('Result must be branch, message or files.');
  return result.kind==='branch'?null:{kind:result.kind};
}
export function requestedBudget(input) {
  if(input.budget_v1===undefined)return null;
  const budget=input.budget_v1;
  const fields=['effort'];
  if(!budget||typeof budget!=='object'||Array.isArray(budget)||Object.keys(budget).length===0||
    Object.keys(budget).some(key=>!fields.includes(key)))usage('Choose an effort.');
  if(Object.hasOwn(budget,'effort')&&!['none','minimal','low','medium','high','xhigh','max'].includes(budget.effort))
    usage('Budget effort is invalid.');
  return {...budget};
}
const agentNames=HARNESS_ADAPTERS.map(adapter=>adapter.spec.harness_id);
function agentChoices(name) {
  if(!name) return undefined;
  if(name==='claude-code') return ['claude-code-subscription','claude-code-api-key'];
  if(agentNames.includes(name)) return [name];
  usage('Unknown agent. Valid agents: '+['claude-code',...agentNames].join(', ')+'.');
}
const usage = message => { throw new UsageError(message); };
const iso = seconds => new Date(seconds * 1000).toISOString().replace('.000Z', 'Z');
function optionalStopReadUnavailable(error, signal) {
  if (signal?.aborted || error?.name === 'AbortError') return false;
  const status=error?.status;
  return error?.code === 'network_error' || [404,408,425,429].includes(status) || status >= 500;
}
export function statusLabel(view) {
  return jobStatusLabel(view);
}
// CLI-local pure copy: the installed CLI does not ship ui/. Owner will unify the copy later.
const copyName = value => typeof value === 'string' && !value.startsWith('sha256:')
  ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim() : '';
function presenceTime(value, zone = 'UTC', date = false) {
  const at = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(at)) return '';
  try { return new Intl.DateTimeFormat('en-US', {timeZone:zone,hour:'numeric',minute:'2-digit',
    ...(date ? {month:'short',day:'numeric',year:'numeric'} : {})}).format(at); } catch { return ''; }
}
export function presenceLine(presence = {}, viewer = {}) {
  if (presence.approvalFor && presence.approvalFor === viewer.id) return 'Waiting for you to say yes';
  const person = presence.person ?? {}, key = typeof person === 'string' ? person : person.id ?? person.key_id;
  const nickname = viewer.petnames instanceof Map ? viewer.petnames.get(key) : viewer.petnames?.[key];
  const name = copyName(nickname?.label ?? nickname) || copyName(person.localName) ||
    copyName(person.display_name ?? person.name ?? person.device_name);
  if (presence.waiting_reason === 'all_declined') return 'Nobody can take this job right now.';
  if (presence.mode === 'ask' && name) return name + ' says yes before each job';
  if (presence.basis === 'recent-activity') return 'Waiting';
  if (presence.state === 'off') return 'Not lending';
  const at = typeof presence.last_poll_at === 'number' ? presence.last_poll_at : Date.parse(presence.last_poll_at);
  const age = viewer.now - at;
  if (!Number.isFinite(age) || age < 0) return 'Waiting';
  if (age >= 900000) return 'Offline since ' + presenceTime(presence.last_poll_at, viewer.timeZone, true);
  if (age >= 90000) return 'Away · last seen ' + Math.floor(age / 60000) + ' min ago';
  if (presence.state === 'resting') return 'Resting' +
    (presenceTime(presence.until, viewer.timeZone) ? ' until ' + presenceTime(presence.until, viewer.timeZone) : '');
  return ['ready','running'].includes(presence.state) ? 'Lending now' : 'Not lending';
}
export function failureVM(code, phase) {
  if (!knownFailures.has(code)) return {headline: NEUTRAL_FAILURE};
  let headline = NEUTRAL_FAILURE;
  if (['lease_expired','lease_expired_unproven','lease_uncertain','network_error','sandbox_crash',
    'restart_interrupted','stale_attempt','cessation_unverified','execution_observation_failed','lender_failed',
    'lender_stopped','sandbox_stop_failed','stop_report_pending'].includes(code)) headline = INTERRUPTED;
  if (code === 'update_in_progress') return {headline: 'Lending waits while Faravan finishes an update.'};
  if (code === 'no_current_job') return {headline: 'No job was running when the action arrived.'};
  if (['requirements_unsupported','policy_unenforceable','expired'].includes(code)) headline = 'Nobody can take this job right now.';
  else if (['candidate_missing','candidate_invalid','git_commit_unverified'].includes(code))
    headline = "The work finished, but the changes didn't arrive safely.";
  else if (['agent_signed_out','agent_not_ready','sandbox_not_ready','readiness_changed','sandbox_start_failed',
    'sandbox_ready_timeout','entrypoint_start_failed'].includes(code) || phase === 'prepare')
    headline = "Waiting · The lender's computer needs a moment";
  else if (['wall_timeout','output_too_large','execution_failed','tests_failed','agent_exit_nonzero','agent_group_not_ceased','agent_run_failed'].includes(code))
    headline = "The agent couldn't finish.";
  return {headline};
}
const INTERRUPTED = 'Interrupted. The agent may have done part of the work. Nothing came back.';
const NEUTRAL_FAILURE = 'The action could not be completed. Check the job status for details.';
const knownFailures = new Set(FAILURE_CODES);
export function failureMessage(code, phase) {
  const model = failureVM(code, phase);
  return !knownFailures.has(code) ? NEUTRAL_FAILURE : model.headline;
}
export function waitingLine(view, viewer = {}) {
  if(view?.waiting_reason==='agent_unavailable')return 'Waiting · '+view.waiting_message+'. This job will wait for a suitable computer.';
  const shared=view?.statusContract?.lifecycle==='waiting'?view.statusContract.explanation:waitingSummary(view?.presence,viewer);
  if(shared)return shared;
  const page = view?.presence ?? {}, now = viewer.now ?? Date.now();
  const devices = (page.devices ?? []).filter(d => d.device !== viewer.id);
  // Report presence, never infer that a device is eligible for this job.
  const lines = devices.map(d => presenceLine({state:d.online === false ? undefined : d.intent?.state ?? (d.source === 'poll' && d.online === true ? 'ready' : undefined),
    last_poll_at:d.source === 'heartbeat' ? d.last_heartbeat_at : d.last_poll_at,
    until:d.intent?.until}, {...viewer, now}));
  const detail = lines.length ? [...new Set(lines)].join(' · ') : presenceLine(page, {...viewer, now});
  return (detail === 'Waiting' ? detail : 'Waiting · ' + detail) + ' · Check again shortly.';
}
export function statusMessage(view, viewer = {}) {
  const projection=view?.jobProjection !== undefined ? createJobProjection(view.jobProjection) : adaptLegacyJob(view);
  const {phase}=projection;
  if(phase==='stopping') return 'Stopping. The running computer has not confirmed it stopped. Check again shortly.';
  if(phase==='waiting'&&projection.evidence.launchFenceUntil)
    return launchFenceLine(presenceTime(projection.evidence.launchFenceUntil, viewer.timeZone, true));
  if(phase==='waiting') return projection.evidence.rawState==='queued' ? waitingLine(view, viewer)
    : 'Waiting. A computer took this job and is getting ready. Check again shortly.';
  // A held own job names its reason and the one action that clears it; the hold is set by the app, never by the projection.
  if(phase==='approval_pending'&&view?.approvalHold) return view.approvalHold.reason+' '+view.approvalHold.action+' Check again shortly.';
  if(phase==='approval_pending') return 'Waiting for an answer. A lender needs to approve your job. Check again shortly.';
  if(phase==='approved') return 'Approved. A lender approved your job and is getting ready. Check again shortly.';
  if(phase==='starting') return 'Starting. A lender is preparing to run your job. Check again shortly.';
  if(phase==='running') return 'Working. A lender is running your job. Check again shortly.';
  if(phase==='result_accepted') {
    const id=shortId(view.job_digest);
    // Only a branch result has changes to apply; a message or files result is read or downloaded.
    // The operations return the projected view (resultKind); a raw signed job carries the payload instead.
    const kind=view.resultKind??(view.job?.payload?p.resultKind(view.job.payload):'branch');
    if(kind!=='branch')
      return 'Ready to review. Run faravan job result '+id+' --out ./review-result to download the answer, then read it before you use it.';
    return 'Ready to review. Run faravan apply '+id+' to put the changes on a new branch, then review and test it.';
  }
  if(phase==='stopped') return projection.reasonCode==='cancelled_before_start' ? 'Cancelled. Nothing ran.' : 'Cancelled. Work has stopped.';
  if(phase==='failed') {
    const code = view.current_attempt?.reason, known = knownFailures.has(code);
    return failureMessage(code, projection.evidence.executionStartedAt ? 'run' : undefined) +
      (known ? '\nCode: ' + code + '\nID: ' + classify(code, undefined, view.job_digest).error_id : '') +
      '\nSee details: faravan job status ' + shortId(view.job_digest);
  }
  if(phase==='expired') return 'Expired. Submit a new job if you still need the work.';
  return 'Status unavailable. Check again shortly.';
}

export function problemForError(error) {
  const code = typeof error?.code === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(error.code) ? error.code :
    ['TimeoutError', 'AbortError'].includes(error?.name) ? 'network_error' : 'internal_error';
  // Never echo remote problem text, paths, invite fragments, or exception stacks.
  const messages = {claude_account_unavailable:'The selected Claude account is unavailable. Check its saved token and run faravan accounts check KEY.', claude_token_invalid:'The Claude token format is invalid. Supply a setup token or API key on standard input.', app_already_running:'Faravan is already running. Run faravan app open-link to open it.', invalid_request:'Check the command and its arguments.', not_found:'The requested item was not found.',
    lock_identity_unavailable:'Faravan could not verify this process start identity. Try starting it again.',
    native_credentials_owner_only:'Native sign-in is only for your own jobs. To lend a subscription, sign in to its Docker credential proxy on the Lend page.',
    source_changed:'The project changed since the preview. Check the folder again and review the updated files before sending.',
    invalid_working_directory:'The selected working directory is invalid, missing or contains a symbolic link.',
    circle_not_found:'The circle was not found.', circle_not_provisioned:'This server is not set up for this circle yet. Apply the local provisioning file on the server.', conflict:'The request conflicts with existing state.',
    timeout:'The job is still pending. Check its status again.', network_error:"The circle's host is not responding. Try again when it is back.",
    circle_unreachable:"The circle's host is not responding. Lending is on, and it starts by itself when the host is back.",
    resume_pending:'Lending is on. Faravan is still starting it.',
    cancelled:'The job was cancelled.', origin_required:'This circle has no server yet. Run faravan host to share this computer, or faravan circle join with an invite.',
    invalid_invite_link:'That invitation link is not valid. Ask for a new one.', enrollment_expired:'That invitation has expired. Ask for a new one.',
    invitation_revoked:'This invitation was revoked. Ask for a new invitation.',
    enrollment_rejected:'This invitation or circle membership request was declined. Ask for a new invitation.',
    device_busy:'Faravan is busy with another action. Wait a moment, refresh, and try again.',
    ownership_transfer_required:'Ownership changes need transfer acceptance. Transfer ownership or close the circle before its owner computer leaves.',
    ownership_transfer_pending:'Cancel the pending transfer before deleting local data.',
    circle_must_be_closed:'Close the circle before deleting local membership data.',
    circle_closed:'This circle is closed; shared history remains readable.',
    person_link_refresh_required:'Refresh the circle on both computers and create new link proofs. Older proofs do not bind consent to the current circle.',
    invalid_person_link:'The computer-link proofs do not match. Create a proof on each selected computer again.',
    role_conflict:'Set the same role on both computers before linking them.',
    person_blocked:'Unblock the person before linking computers or granting circle authority.',
    publication_pending:'Wait for membership publication to finish, then try again.',
    transfer_expired:'The transfer code expired. Ask the owner for a new code.',
    transfer_mismatch:'The transfer code does not match this circle. Ask the owner for a new code.',
    authority_chain:'Circle authority changed. Refresh the circle before creating a new transfer code.',
    circle_members_need_update:'Update every member computer before changing shared circle details or access.',
    host_update_required:'Update the computer hosting this circle before changing circle access.',
    invite_not_found:'That invitation was not found. Check the link or ask for a new one.',
    invite_binding_invalid:'That invitation could not be verified, so it was not used. Ask for a new link.',
    link_rejected:'This source contains symbolic or hard links. Remove them from the source copy before sending.',
    destination_conflict:'Choose an empty result directory.', result_unavailable:'The result is not ready.',
    invalid_petname:'Use 1 to 64 visible characters for a local name.',
    not_owner:'Only this circle’s owner can change its details.',
    invalid_circle_profile:'Use a circle name and an optional purpose of up to 256 characters each.',
    petname_label_taken:'You already use that local name for another member of this circle. Add a qualifier to tell them apart.',
    docker_signed_out:DOCKER_SIGNED_OUT_MESSAGE,
    host_too_old:"This circle's host runs an older Faravan that can't do that yet. Ask them to update.",
    client_update_required:'Update Faravan on this computer before making changes in this circle.',
    sandbox_credential_store_failed:'Docker Sandboxes could not read its saved Docker sign-in. Run faravan doctor to check sign-in storage.',
    job_running:'A job is running. Confirm stopping this exact job before quitting. Nothing was changed.',
    job_changed:'The job or its stop confirmation changed. Review the current job before quitting. Nothing was changed.',
    cessation_unverified:"Faravan couldn't confirm that the job's sandbox has stopped, so it stays open until it can.",
    sandbox_cleanup_unverified:'Sandbox cleanup records are incomplete or do not match this job. The hold stays open.',
    verification_missing:'The result does not include the check this job requested.',
    verification_mismatch:'The result check does not match the command this job requested.',
    config_changed:'Nothing was saved. Your lending settings changed since you opened this page.',
    lending_busy:'Pause lending or stop the running job, then try again.',
    app_quitting:'Faravan is quitting. It is confirming that no lent sandbox is still running.',
    circle_ambiguous:'Choose the circle you want to lend to, then try again.',
    draft_changed:'This draft already names a different send. Start a new draft to change the source, prompt or agent.',
    device_removed:"This computer was removed from that circle, and a removed computer can't join it again.",
    rate_limited:'The circle host is busy. Nothing was changed. Try again in a moment.',
    previous_coordinator_other_install:'The recorded hosting process appears to use a different program path. Faravan could not verify it as this copy, so it was left running. Check the Faravan installation that started hosting and stop hosting there before trying again.',
    host_still_running:'Hosting is still running. Faravan could not stop the program that serves this circle, so it was left running. Run faravan host --stop to see which program it is.',
    host_config_unreadable:'Faravan could not read the hosting settings saved on this computer, so it changed nothing. Fix or move the file named in the error, then run the command again.',
    host_home_conflict:'Two folders on this computer hold hosting data for the same circle, so Faravan did not choose one. Run faravan host to see both folders, then set FARAVAN_COORDINATOR_HOME to the one to keep.',
    internal_error:'The request could not be completed.'};
  if(code==='approval_pending') {
    const approvalId=typeof error?.approvalId==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(error.approvalId)?error.approvalId:null;
    return {code,message:'Approval'+(approvalId?' '+approvalId:'')+' is waiting for your review. Review it before quitting. Nothing was changed.',
      ...(approvalId?{approvalId}:{})};
  }
  if(error?.agentAvailability)return {code:'agent_unavailable',message:error.agentAvailability.message,
    ...(error.agentAvailability.canSendAnyway===false?{}:{action:{label:'Send anyway',input:{send_anyway:true}}}),...outcomeFields(error)};
  if(code==='confirmation_required') return {code,message:'Confirm the send at a terminal, or pass --yes after reviewing the effect.',effect:error.effect};
  if(['circle_required','circle_changed'].includes(code)) return {code,message:error.message};
  const outcome=outcomeFields(error);
  // A send that may have arrived is never sent again: it is saved, the app keeps delivering it, and the person follows it.
  if(outcome.jobDigest)return {code,message:savedSendMessage(outcome.jobDigest),...outcome};
  return {code, message: error instanceof UsageError ? error.message : Object.hasOwn(messages, code) ? messages[code] : failureMessage(code, error?.phase),
    ...outcome,
    ...(knownFailures.has(code) && !(error instanceof UsageError) ? {error_id:classify(code, error?.phase, error?.job_digest).error_id} : {})};
}
const savedSendMessage = digest => 'Your job is saved on this computer and may already have reached the circle\'s host. '+
  'Faravan keeps sending this same job while the app is open; the host computer must be online to receive it. '+
  'Do not send it again. Follow it with: faravan jobs wait '+shortId(digest);
export const problemText = problem => problem.message + (problem.effect ? '\n' + problem.effect : '') +
  (problem.outcome === 'unknown' && !problem.jobDigest ? '\nOutcome: unknown. Check the original send before starting another.' : '') +
  (problem.operationKey && !problem.jobDigest ? '\nOperation key: ' + problem.operationKey : '') +
  (problem.error_id ? '\nCode: ' + problem.code + '\nID: ' + problem.error_id : '');
export function exitCodeForError(error) {
  if (error?.code === 'confirmation_required') return 6;
  if (error instanceof UsageError || ['invalid_request','circle_required'].includes(error?.code)) return 2;
  if (error?.status === 404 || ['not_found','circle_not_found','circle_not_provisioned','job_not_found'].includes(error?.code)) return 3;
  if (error?.status === 409 || ['conflict','destination_conflict','circle_ambiguous'].includes(error?.code)) return 4;
  if (error?.retryable || error?.code === 'timeout') return 5;
  return 1;
}
/** Used only at CLI send boundaries, before reading a prompt file or packaging source. */
export async function confirmJobSend(effect, accepted, {stdin = process.stdin, stderr = process.stderr} = {}) {
  if (accepted === true) return;
  if (stdin.isTTY) {
    const {createInterface} = await import('node:readline');
    const rl = createInterface({input:stdin, terminal:false});
    const answer = new Promise(done => { rl.once('line', done); rl.once('close', () => done('')); });
    stderr.write(effect + '\nSend this job? [y/N] ');
    const yes = /^y(es)?$/i.test((await answer).trim());
    rl.close();
    if (yes) return;
  }
  throw Object.assign(new Error('Confirmation is required before sending code.'), {code:'confirmation_required',status:428,effect});
}
function project(view, includeIdentity = false) {
  const sourceKind=view.job?.payload?.source?.kind;
  const wallSeconds=view.job?.payload?.requirements?.limits?.wall_seconds;
  const startedAt=Date.parse(observedExecutionTime(view.current_attempt)??'');
  const hardStopAt=Number.isSafeInteger(wallSeconds)&&wallSeconds>0&&Number.isFinite(startedAt)&&
    Number.isFinite(startedAt+wallSeconds*1000)?new Date(startedAt+wallSeconds*1000).toISOString():null;
  return {job_digest:view.job_digest,state:view.state,status:statusLabel(view),attempts_started:view.attempts_started,
    current_attempt:view.current_attempt,result_digest:view.result_digest,
    ...(Number.isSafeInteger(view.declined_count)?{declined_count:view.declined_count}:{}),
    ...(typeof sourceKind==='string' ? {sourceKind} : {}),
    ...(hardStopAt?{hardStopAt}:{}),
    ...(view.job?.payload?.result ? {resultKind:p.resultKind(view.job.payload)} : {}),
    ...(includeIdentity ? {historyIdentity:{author:view.job?.payload?.author??null,deviceName:view.job?.payload?.device_name??null}} : {})};
}

// Only explicit heartbeat advertisements establish agent availability. Old hosts remain unknown.
// This computer counts when it lends the agent: it claims and runs a job it signed itself (lender.mjs ownJob).
function unavailableAgent(page,required,circle) {
  if(!required?.length||!Array.isArray(page?.devices))return null;
  if(page.devices.some(d=>!d||typeof d!=='object'||typeof d.device!=='string'||!d.device||typeof d.online!=='boolean'))return null;
  const online=page.devices.filter(d=>d.online===true);
  if(online.some(d=>d.source!=='heartbeat'||!Array.isArray(d.agents)||
    d.agents.some(a=>!a||typeof a.adapter!=='string')||
    !['off','paused','outside','resting','ready','starting','blocked','update'].includes(d.intent?.state)))return null;
  if(online.some(d=>d.intent?.state!=='off'&&d.agents.some(a=>required.includes(a.adapter)&&
    !['ready','signed_out','not_installed'].includes(a.readiness))))return null;
  if(online.some(d=>d.intent?.state!=='off'&&d.agents.some(a=>required.includes(a.adapter)&&a.readiness==='ready')))return null;
  const name=required.every(id=>id.startsWith('claude-code-'))?'Claude Code':
    ({codex:'Codex',gemini:'Gemini',opencode:'OpenCode','gh-cli':'GitHub CLI'})[required[0]]??required[0];
  return {code:'agent_unavailable',message:'No computer in the circle “'+circle+'” lends '+name+' right now'};
}
function gitSource(value, commit) {
  if (typeof value !== 'string') usage('Provide a repository URL and full commit.');
  if (!commit) { const at=value.lastIndexOf('@'); if(at<0) usage('Use --git URL@COMMIT.'); commit=value.slice(at+1); value=value.slice(0,at); }
  let url; try { url=new URL(value); } catch { usage('Provide an HTTPS repository URL.'); }
  if(url.protocol!=='https:' || url.username || url.password || url.hash || url.search ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) usage('Use a credential-free HTTPS URL and a full lowercase commit.');
  return {kind:'git',url:value,commit,object_format:commit.length===40?'sha1':'sha256'};
}
// Result extractions made without an explicit destination live under
// <home>/results. They are pruned before each new one: anything older than
// RESULT_MAX_AGE_MS goes, and only the RESULT_KEEP newest of the rest stay.
export const RESULT_MAX_AGE_MS=7*24*3600*1000, RESULT_KEEP=20;
export const resultsDirectory=home=>join(resolve(home ?? configHome()),'results');
export async function pruneResults(dir,{now=Date.now(),maxAgeMs=RESULT_MAX_AGE_MS,keep=RESULT_KEEP}={}) {
  let names; try { names=await readdir(dir); } catch(error) { if(error.code==='ENOENT') return; throw error; }
  const entries=[];
  for(const name of names) { try { entries.push({name,time:(await stat(join(dir,name))).mtimeMs}); } catch { /* vanished */ } }
  entries.sort((a,b)=>b.time-a.time);
  for(const [index,entry] of entries.entries())
    if(index>=keep || now-entry.time>maxAgeMs) await rm(join(dir,entry.name),{recursive:true,force:true});
}
async function emptyDestination(path) {
  const target=resolve(path);
  let info; try { info=await lstat(target); } catch(error) { if(error.code!=='ENOENT') throw error; }
  if(info && (!info.isDirectory() || info.isSymbolicLink() || (await readdir(target)).length)) {
    const error=new Error('Destination conflict'); error.code='destination_conflict'; throw error;
  }
  await mkdir(target,{recursive:true,mode:0o700}); return target;
}
async function previewAt(path, max=4096) {
  const names=await readdir(path);
  const name=['changes.patch','summary.txt','summary.md','README.md'].find(n=>names.includes(n));
  if(!name) return 'Verified result contains ' + names.length + ' top-level entries. Review and test before use.';
  const file=await open(join(path,name),'r');
  try { const bytes=Buffer.alloc(max); const {bytesRead}=await file.read(bytes,0,max,0); return bytes.subarray(0,bytesRead).toString('utf8'); }
  finally { await file.close(); }
}
export function createJobOperations(options={}) {
  let devicePromise;
  const observedAttempts=new Map(),runReceipts=new Map(),sharedStops=new Map();
  const finishedStopReads=new Map();
  const attemptKey=(circle,digest)=>circle+':'+digest;
  function remember(circle,view) {
    const key=attemptKey(circle,view.job_digest), next=view.current_attempt, prior=observedAttempts.get(key);
    // A delayed queued/older snapshot cannot erase a newer independently retained binding.
    if(!next || (prior && next.generation<prior.generation)) return view;
    if(prior && next.generation===prior.generation &&
        ['job_digest','attempt_id','holder'].some(field=>next[field]!==prior[field])) {
      const error=new Error('Conflicting attempt identity'); error.code='stale_attempt'; throw error;
    }
    // Compatible observations can refresh attempt state; only a newer generation can change identity.
    observedAttempts.set(key,structuredClone(next));
    return view;
  }
  // The submitting device keeps its own prompt, title, source and agent, keyed by job digest.
  const meta=createJobMetaStore(join(resolve(options.home ?? configHome()),'v1'));
  const withLocal=async (view,displayMeta=null)=>{
    let local=await (displayMeta??meta).get(view.job_digest);
    if(local) {
      const prior=local.runs?.find(run=>run.attempt_id===view.current_attempt?.attempt_id);
      const next=view.current_attempt?{...view.current_attempt,...(view.result_digest?{result_digest:view.result_digest}:{})}:null;
      // The request snapshot can skip only an unchanged observation. Writes still reread under their lock.
      if(!displayMeta || next&&JSON.stringify(prior)!==JSON.stringify(next)) {
        await meta.observe(view.job_digest,view);local=await meta.get(view.job_digest);
      }
    }
    return local?{...view,local}:view;
  };

  const device=()=>devicePromise ??= Promise.resolve(options.device ?? openDevice(options));
  async function withRunFacts(view,signed,circle,own,client,opts={}) {
    const author=signed.job?.payload?.author,attempt=signed.current_attempt;
    if(!author||author===own||signed.job?.payload?.circle!==circle||attempt?.holder!==own||
       attempt.job_digest!==view.job_digest)return view;
    const observed=await (opts.displayRunFacts??options.runFacts)?.({circle,jobDigest:view.job_digest,keyId:author,attemptId:attempt.attempt_id});
    // Acceptance retains the selected adapter, but only an acknowledged attempt start makes it a run.
    const facts=observed?.kind==='accepted'&&typeof observedExecutionTime(attempt)!=='string'?null:observed;
    const title=facts?[...cleanTitle(view.local?.title||facts.title)].slice(0,120).join(''):'';
    let agent=agentNames.includes(facts?.agent)?facts.agent:undefined;
    if(!agent&&signed.state==='result-accepted'&&signed.result_digest&&attempt.state==='completed'&&
       typeof client.fetchReceipt==='function') {
      // Cache verified immutable result metadata only, never prompt or result artifact bytes.
      const key=JSON.stringify([circle,view.job_digest,signed.result_digest,attempt.attempt_id,attempt.generation,attempt.holder]);
      let receipt=runReceipts.get(key);
      if(!receipt) {
        receipt=client.fetchReceipt(view.job_digest,{...opts,attempt:structuredClone(attempt)})
          .then(value=>value.receipt?.harness).catch(error=>{
            if(runReceipts.get(key)===receipt)runReceipts.delete(key);
            throw error;
          });
        runReceipts.set(key,receipt);
        if(runReceipts.size>100)runReceipts.delete(runReceipts.keys().next().value);
      }
      try {const harness=await receipt;if(agentNames.includes(harness))agent=harness;}
      catch(error){if(opts.signal?.aborted)throw error;}
    }
    return {...view,...(title?{title}:{}),...(agent?{agent}:{})};
  }
  function rememberSubmission(store,circle,slot,intent) {
    return store.set('job:'+intent.jobDigest,{jobDigest:intent.jobDigest,circle:circle.id,slot,
      ...(intent.payload.designated_member===undefined?{}:{envelope:intent.envelope})});
  }
  async function context(name,readDigest,designatedMember) {
    const d=await device(), circle=await d.selectCircle(name);
    const client=designatedMember?await d.memberClient(circle.id,designatedMember):
      readDigest&&d.jobReadClient?await d.jobReadClient(circle.id,readDigest):await d.client(circle.id);
    return {d,circle,client,store:d.intentStore(circle.id)};
  }
  async function pinnedWait(view,signed,d,circle){
    const member=signed.job?.payload?.designated_member;
    if(view.state!=='queued'||!member)return view;
    const name=d.memberNames?(await d.memberNames(circle,{refresh:false})).get(member):null;
    return {...view,waitingHome:name??('computer '+member.slice(-12)),waiting_reason:'agent_unavailable',waiting_message:'This job waits for '+(name??('computer '+member.slice(-12)))+
      ' to be available. Choose Stop, then send again to choose a computer afresh'};
  }
  // Accepts a full digest or a unique prefix (6+ hex characters, with or without sha256:).
  async function locate(input,{readJob=true}={}) {
    const id=classifyJobId(input.digest);
    if(id.kind==='invalid') usage(id.reason==='short'?'Job ID is too short: use at least '+MIN_PREFIX_LENGTH+' characters.':'Provide a job ID (the short ID faravan printed).');
    const d=await device();
    const circles=input.circle ? [await d.selectCircle(input.circle)] : await d.listCircles();
    const known=new Map();
    for(const circle of circles) for(const intent of await d.intentStore(circle.id).list())
      if(intent?.jobDigest && (id.kind==='full' ? intent.jobDigest===id.digest : intent.jobDigest.startsWith('sha256:'+id.hex))) known.set(intent.jobDigest,circle.id);
    let digest=id.kind==='full' ? id.digest : null;
    if(id.kind==='prefix') {
      let matches=matchPrefix(id.hex,[...known.keys()]);
      if(!matches.length) {
        // Not submitted from this device: ask the circle.
        const remote=await context(input.circle), found=[];
        for await(const view of remote.client.listJobs({})) found.push(view.job_digest);
        matches=matchPrefix(id.hex,found);
        if(matches.length===1) known.set(matches[0],remote.circle.id);
      }
      if(!matches.length) { const e=new Error('Job not found'); e.code='not_found'; throw e; }
      if(matches.length>1) usage('That ID matches more than one job. Use more characters:\n'+matches.map(m=>'  '+shortId(m)+'  ('+m+')').join('\n'));
      digest=matches[0];
    }
    const circle=known.get(digest);
    return {...(await context(circle ?? input.circle,readJob?digest:undefined)),digest};
  }
  async function fetchVerified(input,method,{signal,...opts}={}) {
    const {client,circle,digest}=await locate(input,{readJob:true}), key=attemptKey(circle.id,digest);
    // Prefer an earlier status/wait observation. A first download takes a separate
    // job snapshot before fetchResult/fetchTranscript perform their own reads.
    // Both observations still come from the coordinator, not a separate trust root.
    if(!observedAttempts.has(key)) remember(circle.id,await client.getJob(digest,{signal}));
    const attempt=structuredClone(observedAttempts.get(key));
    // Verification failures propagate without refreshing, clearing or repinning the cache.
    return client[method](digest,{...opts,signal,attempt});
  }
  // Replay first: a lost reply may already have revoked authority. Only a
  // definitive stale-roster refusal permits replacing the signed bytes/key.
  async function sendCancellation(d,circle,client,store,slot,intent,signal) {
    try { return {intent,result:await client.cancelJob(intent.payload.job_digest,{signal,idempotencyKey:intent.operationKey,payload:intent.payload})}; }
    catch(error) {
      if(error.code!=='roster_stale'||error.status!==409||error.outcome!=='not_applied')throw error;
      const snapshot=await d.rosterCache(circle.id).get();
      if(snapshot.current.payload.epoch<=intent.payload.roster_epoch)throw error;
      intent={...intent,state:'pending',operationKey:randomUUID(),payload:{...intent.payload,
        roster_epoch:snapshot.current.payload.epoch,created_at:iso((options.clock??(()=>Math.floor(Date.now()/1000)))())}};
      await store.set(slot,intent);
      const result=await client.cancelJob(intent.payload.job_digest,{signal,idempotencyKey:intent.operationKey,payload:intent.payload});
      return {intent,result};
    }
  }
  // Share one optional lookup across the incumbent and fallback member stores in a circle list.
  function jobHomeFor(d,circle) {
    let roster;
    return async signed=>{
      const member=signed.job?.payload?.designated_member;
      if(!member)return {origin:circle.origin,ownerOrigin:circle.origin};
      roster??=Promise.resolve().then(()=>d.rosterCache(circle.id).get())
        .then(snapshot=>{const members=snapshot?.current?.payload?.members;return Array.isArray(members)?members:[];},()=>[]);
      const origin=(await roster).find(row=>row?.key_id===member)?.origin??null;
      return {origin,ownerOrigin:circle.origin};
    };
  }
  /** The circle's job list and how much of it was checked. The incumbent host answers for the whole circle. When
   *  it is unreachable and the caller asks for `memberFallback`, each member store the accepted signed roster
   *  records an origin for is read with this device's own signed request, so each store applies its own per-reader
   *  visibility. A store is authoritative only for jobs that name its member as the designated member, so only those
   *  rows are kept, and the result is marked partial: jobs only the incumbent holds cannot be supplied. A refusal
   *  (an auth or access error) from the incumbent is never replaced by member answers. */
  async function listWithCoverage(input={},opts={}) {
    const d=await device(), circle=await d.selectCircle(input.circle);
    const jobHome=jobHomeFor(d,circle);
    const listFrom=async (client,keep=()=>true,readOpts=opts)=>{
      const result=[];
      let page,readPresence=false;
      for await(const view of client.listJobs(readOpts)) {
        readOpts.signal?.throwIfAborted();
        if(!keep(view))continue;
        const projected=await withRunFacts(await withLocal(project(remember(circle.id,view),input.includeIdentity),readOpts.displayMeta),view,circle.id,d.keyId,client,readOpts);
        projected.jobHome=await jobHome(view);
        const attempt=view.current_attempt,stopKey=attemptKey(circle.id,view.job_digest);
        const resultAccepted=['result-accepted','finished'].includes(view.state);
        if(attempt&&typeof attempt.execution_started_at==='string'&&
          (attempt.state==='active'&&attempt.compute_stopped!==true||resultAccepted)&&
          typeof client.getStopRequest==='function') {
          const kept=sharedStops.get(stopKey);
          const same=kept&&kept.attempt_id===attempt.attempt_id&&
            kept.generation===attempt.generation&&kept.job_digest===view.job_digest;
          const readKey=JSON.stringify([stopKey,attempt.attempt_id,attempt.generation]);
          try {
            let stopRequest;
            if(resultAccepted&&same)stopRequest=structuredClone(kept);
            else {
              // Completed attempts are immutable; retain null reads too and share an in-flight read.
              let read=resultAccepted?finishedStopReads.get(readKey):null;
              if(!read) {
                read=Promise.resolve().then(()=>client.getStopRequest(attempt,readOpts));
                if(resultAccepted)finishedStopReads.set(readKey,read);
              }
              stopRequest=await read;
              if(stopRequest)sharedStops.set(stopKey,structuredClone(stopRequest));
              else sharedStops.delete(stopKey);
            }
            if(stopRequest) {projected.stopRequest=structuredClone(stopRequest);projected.status=statusLabel({...view,stopRequest});}
          } catch(error) {
            finishedStopReads.delete(readKey);
            if(!optionalStopReadUnavailable(error,readOpts.signal))throw error;
            // Optional outages leave the existing row intact; retry on the next list read.
          }
        }
        if(view.state==='queued'&&view.job?.payload?.requirements?.harness?.length) {
          if(!readPresence&&typeof client.fetchPresence==='function') {
            readPresence=true;
            try {page=await client.fetchPresence({...readOpts,signal:readOpts.signal?AbortSignal.any([readOpts.signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000)});}
            catch(error){if(readOpts.signal?.aborted)throw error;}
          }
          const availability=unavailableAgent(page,view.job.payload.requirements.harness,circle.name);
          if(availability)Object.assign(projected,{waiting_reason:availability.code,waiting_message:availability.message});
        }
        readOpts.signal?.throwIfAborted();
        const waiting=await pinnedWait(projected,view,d,circle.id);
        result.push(input.includeSubmissionTime?{...waiting,submittedAt:view.job.payload.created_at}:waiting);
      }
      return result;
    };
    try {
      return {items:await listFrom(await d.client(circle.id)),coverage:{state:'complete'}};
    } catch(error) {
      if(opts.memberFallback!==true||typeof d.memberReadClients!=='function'||
        classifyHostFailure(error,{callerSignal:opts.signal}).code!==CIRCLE_UNREACHABLE)throw error;
      const members=[],items=[];
      const timerAbort=new AbortController();
      const signal=opts.signal?AbortSignal.any([opts.signal,timerAbort.signal]):timerAbort.signal;
      const timer=setTimeout(()=>timerAbort.abort(),opts.memberFallbackTimeoutMs??1500);
      const bounded=async work=>{
        signal.throwIfAborted();
        let cancel;
        const stopped=new Promise((_,reject)=>{cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});});
        try{return await Promise.race([Promise.resolve().then(work),stopped]);}
        finally{signal.removeEventListener('abort',cancel);}
      };
      try {
        let candidates;
        try{candidates=await bounded(()=>d.memberReadClients(circle.id,{signal}));}
        catch(failure){opts.signal?.throwIfAborted();if(timerAbort.signal.aborted)throw error;throw failure;}
        for(const member of candidates) {
          opts.signal?.throwIfAborted();
          if(timerAbort.signal.aborted)break;
          try {
            // Publish only a whole, finished store; the timeout never promotes in-flight rows.
            const rows=await bounded(()=>listFrom(member.client,view=>view.job?.payload?.designated_member===member.keyId,{...opts,signal}));
            items.push(...rows);
            members.push({keyId:member.keyId,state:'listed'});
          } catch(failure) {
            opts.signal?.throwIfAborted();
            const status=failure?.status;
            members.push({keyId:member.keyId,state:timerAbort.signal.aborted?'unreachable':
              [401,403].includes(status)||['forbidden','unauthorized','not_member'].includes(failure?.code)?'denied'
              :classifyHostFailure(failure).code===CIRCLE_UNREACHABLE?'unreachable':'failed'});
          }
        }
        if(!members.some(member=>member.state==='listed'))throw error;
        return {items,coverage:{state:'partial',reason:'incumbent_unreachable',members}};
      } finally {clearTimeout(timer);}
    }
  }
  return {
    /** Recover saved authorizations. Submissions retain their original bytes and keys. */
    async recoverPending({signal,limit=16}={}) {
      const d=await device(),outcomes=[],pending=[];
      for(const circle of await d.listCircles()) {
        const store=d.intentStore(circle.id);
        if(!store.entries)continue;
        for(const [slot,intent] of await store.entries())if((intent.state==='pending'||
          intent.state==='refused'&&intent.kind==='cancel'&&intent.lastError==='roster_stale')&&['submit','cancel'].includes(intent.kind))
          pending.push({circle,store,slot,failures:intent.recoveryFailures??0});
      }
      // Persisted retry counts put untouched obligations ahead of repeated
      // outages, across circles and process restarts.
      pending.sort((a,b)=>a.failures-b.failures);
      for(const {circle,store,slot} of pending.slice(0,limit)) {
        await d.withOperationLock(circle.id,async()=>{
            let intent=await store.get(slot);
            if(!intent||!(intent.state==='pending'||intent.state==='refused'&&intent.kind==='cancel'&&intent.lastError==='roster_stale')||
              !['submit','cancel'].includes(intent.kind))return;
            signal?.throwIfAborted();
            try {
              if(intent.payload?.circle!==circle.id||intent.payload?.author!==d.keyId)
                throw Object.assign(new Error('saved_operation_invalid'),{code:'saved_operation_invalid',status:409});
              const client=intent.kind==='cancel'
                ?await d.jobReadClient(circle.id,intent.payload.job_digest)
                :await d.authorityClient(circle.id,{designatedMember:intent.payload.designated_member,signal});
              if(intent.kind==='submit') {
                if(p.digest(intent.payload)!==intent.jobDigest)
                  throw Object.assign(new Error('saved_operation_invalid'),{code:'saved_operation_invalid',status:409});
                await rememberSubmission(store,circle,slot,intent);
                if(intent.localMetadata)await meta.record(intent.jobDigest,intent.localMetadata);
                const epoch=(await d.rosterCache(circle.id).get()).current.payload.epoch;
                let already=false;
                if(epoch!==intent.payload.roster_epoch||!intent.artifacts) {
                  try {already=(await client.getJob(intent.jobDigest,{signal})).job_digest===intent.jobDigest;}
                  catch(error){if(error.status!==404)throw error;}
                  if(!already)throw Object.assign(new Error('roster_stale'),{code:'roster_stale',status:409});
                }
                if(!already) {
                  const prompt=Buffer.from(intent.artifacts.prompt,'base64');
                  if(p.digestBytes(prompt)!==intent.payload.prompt.digest||prompt.length!==intent.payload.prompt.bytes)
                    throw Object.assign(new Error('saved_operation_invalid'),{code:'saved_operation_invalid',status:409});
                  if(intent.artifacts.source!==null) {
                    const source=Buffer.from(intent.artifacts.source,'base64');
                    if(p.digestBytes(source)!==intent.payload.source.artifact.digest||filterSourceArchive(source).omitted.length)
                      throw Object.assign(new Error('invalid_source'),{code:'invalid_source',status:409});
                    await client.uploadArtifact(source,'application/gzip',{signal});
                  }
                  await client.uploadArtifact(prompt,'text/plain',{signal});
                  await client.submitJob(intent.payload,{signal,idempotencyKey:intent.operationKey});
                }
                const {artifacts,...saved}=intent;await store.set(slot,{...saved,state:'complete'});
              } else {
                const sent=await sendCancellation(d,circle,client,store,slot,intent,signal);
                intent=sent.intent;const result=sent.result;
                await store.set(slot,{...intent,state:'complete',result});
              }
              outcomes.push({circle:circle.id,slot,state:'complete'});
            } catch(error) {
              if(signal?.aborted)throw error;
              // A 404 cannot settle cancellation while our own publication may
              // still succeed. Check under the operation lock, regardless of
              // which intent the persisted retry order puts first.
              const publicationPending=intent.kind==='cancel'&&error.status===404&&
                (await store.list()).some(saved=>saved.kind==='submit'&&saved.state==='pending'&&
                  saved.jobDigest===intent.payload.job_digest);
              const refused=error.status>=400&&error.status<500&&error.status!==429&&!publicationPending;
              await store.set(slot,{...await store.get(slot),state:refused?'refused':'pending',lastError:error.code??'network_error',recoveryFailures:(intent.recoveryFailures??0)+1});
              outcomes.push({circle:circle.id,slot,state:refused?'refused':'pending',code:error.code??'network_error'});
            }
        });
      }
      return outcomes;
    },
    async prepareSend(input) { return resolveJobRecipient(input, await defaultJobCircles(await device(), options.home ?? configHome())); },
    fetchReceipt:(input,opts)=>fetchVerified(input,'fetchReceipt',opts),
    fetchResult:(input,opts)=>fetchVerified(input,'fetchResult',opts),
    fetchTranscript:(input,opts)=>fetchVerified(input,'fetchTranscript',opts),
    // A transcript read selects one client: repeated selection refreshes the
    // roster from disk/network. Job state and the optional live read can overlap.
    async transcriptState(input,{signal,includeLive=true}={}) {
      const {client,circle,digest}=await locate(input);
      // Observe both outcomes even if job authorization fails or a completed
      // job makes the speculative relay read irrelevant. Neither waits on it.
      const pending=includeLive?Promise.resolve().then(()=>client.fetchLiveTranscript(digest,{signal}))
        .then(relay=>({relay,relayError:null}),relayError=>({relay:null,relayError})):Promise.resolve({relay:null,relayError:null});
      const view=remember(circle.id,await client.getJob(digest,{signal}));
      await meta.observe(digest,view);
      if(view.state==='result-accepted')return {state:view.state,relay:null,relayError:null};
      return {state:view.state,...await pending};
    },
    async liveTranscript(input,{signal}={}) {
      const {client,digest}=await locate(input);
      return client.fetchLiveTranscript(digest,{signal});
    },
    // Optional progress channel: coarse steps for a job this device sent or ran.
    async progress(input,{signal}={}) {
      const {client,digest}=await locate(input);
      return client.fetchProgress(digest,{after:Number(input.after)||0,signal});
    },
    async submit(input,{signal,prepareSource,sentByAgent=false}={}) {
      if(!input) usage(SOURCE_CHOICE);
      // Typed result: absent and 'branch' are the legacy code-change job (no signed field); message/files are signed.
      let typed=requestedResult(input);
      let runRequest=borrowerRunRequest(input);

      if(input.noSource!==undefined&&input.noSource!==true) usage('noSource must be true when set.');
      if(input.noSource&&!typed&&!input.followup) usage('With no source, choose what comes back: --result message or --result files.');
      const checkRecipient = async () => {
        if (input.expected_circle_id || input.expected_default_circle) resolveJobRecipient(input, await defaultJobCircles(await device(), options.home ?? configHome()));
      };
      if(input.followup!==undefined)checkFollowup(input.followup);
      // The designated member (owner-offline topology): the one member whose store may dispatch this
      // job. The borrower's unchanged signed intent is carried to the origin its signed roster records.
      let designated=input.designated_member??input['designated-member']??null;
      if(designated!==null&&(!/^(null|sha256:[0-9a-f]{64})$/.test(designated)||designated==='null'))
        usage('Use the chosen circle member’s ID (it starts with sha256:).');
      const freezeAudience=input.freeze_audience??input['freeze-audience']??false;
      if(typeof freezeAudience!=='boolean')usage('Freeze audience must be true or false.');
      const agent=input.harness, harness=agentChoices(agent);
      const sendAnyway=input.send_anyway??input['send-anyway']??false;
      if(typeof sendAnyway!=='boolean')usage('Send anyway must be true or false.');
      if(input.verify!==undefined && input['verify-cmd']!==undefined) usage('Provide the check command only once.');
      const requestedVerify=input.verify!==undefined?input.verify:(input['verify-cmd']===undefined?undefined:{cmd:input['verify-cmd']});
      if(requestedVerify!==undefined && (!requestedVerify || typeof requestedVerify!=='object' || Array.isArray(requestedVerify) ||
        Object.keys(requestedVerify).length!==1 || typeof requestedVerify.cmd!=='string' || !requestedVerify.cmd.trim() ||
        requestedVerify.cmd.length>4096 || /[\x00-\x1f\x7f]/.test(requestedVerify.cmd))) usage('The check command must be one line of 1 to 4096 characters.');
      const verify=requestedVerify===undefined?undefined:{cmd:requestedVerify.cmd};
      if(input.working_directory!==undefined)validateWorkingDirectory(input.working_directory);
      await checkRecipient();
      const d=await device(),circle=await d.selectCircle(input.circle),store=d.intentStore(circle.id);
      let client;
      return d.withOperationLock(circle.id,async()=>{
      // Resolve a draft before reading its mutable source or prompt again.
      const draftId=typeof input.draftId==='string'&&/^[A-Za-z0-9-]{8,64}$/.test(input.draftId)?input.draftId:null;
      const draftRequest=draftId?p.digest({
        source:input.draftSource??input.source??input.git??(input.sourceTar?p.digestBytes(input.sourceTar):null),
        commit:input.commit??null,files:input.files??null,...(input.working_directory!==undefined?{working_directory:input.working_directory}:{}),prompt:input.prompt??null,
        promptFile:input.promptFile??input['prompt-file']??null,harness:agent??null,
        model:input.model??null,egress:input.egress??JOB_DEFAULTS.egress,verify:verify??null,
        runRequest,...(designated?{designated_member:designated}:{}),
        ...(freezeAudience?{freeze_audience:true}:{}),...(input.followup?{followup:input.followup}:{}),...(input.noSource?{noSource:true}:{}),...(typed?{result:typed}:{})}):null;
      let slot=draftId?'submit:draft:'+draftId:null;
      let intent=slot?await store.get(slot):null;
      if(draftId&&!intent) {
        // Earlier versions included a content fingerprint in the slot. Bind that
        // original send too, rather than submitting it again after an upgrade.
        const prior=(await store.list()).find(value=>value.slot?.startsWith(slot+':'));
        if(prior) {
          intent=await store.get(prior.slot);
          if(intent) {
            await store.set(slot,intent);
            await rememberSubmission(store,circle,slot,intent);
            await store.delete(prior.slot);
          }
        }
      }
      let sourceBytes,promptBytes,warnings=intent?.warnings??[],sourceOmissions=intent?.sourceOmissions??[],sourceManifest=intent?.sourceManifest;
      const withWarnings=value=>({...value,...(sourceManifest?{sourceManifest}:{}),...(warnings.length?{warnings}:{}),...(sourceBytes || sourceOmissions.length ? {sourceOmissions} : {})});
      const complete=async()=>{const {artifacts,...saved}=intent;await store.set(slot,{...saved,state:'complete'});};
      if(draftId&&intent?.draftRequest&&intent.draftRequest!==draftRequest)
        throw Object.assign(new Error('draft_changed'),{code:'draft_changed',status:409});
      if(intent&&intent.state!=='complete'&&Boolean(intent.payload?.audience)!==freezeAudience)throw Object.assign(new Error('Saved audience policy differs from this submission.'),{code:'audience_policy_changed',status:409});
      const repairLocal=async()=>{
        await rememberSubmission(store,circle,slot,intent);
        if(intent.localMetadata)await meta.record(intent.jobDigest,intent.localMetadata);
      };
      if(draftId&&intent?.state==='complete') {
        await repairLocal();
        return withWarnings({jobDigest:intent.jobDigest,operationKey:intent.operationKey,replayed:true});
      }
      if(!intent) {
        const deltaPrompt=input.prompt;
        if(input.followup)input={...input,...await prepareFollowup({client:await d.jobReadClient(circle.id,input.followup.parentJob),meta,circle:circle.id,followup:input.followup,delta:deltaPrompt,directory:join(resolve(options.home??configHome()),'v1','scratch')})};
        if(input.followup&&input.noSource&&input.result===undefined)typed={kind:'message'};
        if(input.noSource&&!typed)usage('With no source, choose what comes back: --result message or --result files.');
        if(prepareSource) input={...input,...await prepareSource()};
        if([input.source,input.git,input.sourceTar,input.noSource].filter(Boolean).length!==1) usage(SOURCE_CHOICE);
        const promptFile=input.promptFile ?? input['prompt-file'];
        if((input.prompt!==undefined)===(promptFile!==undefined)) usage('Choose exactly one of --prompt and --prompt-file.');
        const prompt=promptFile ? await readFile(promptFile,'utf8') : input.prompt;
        if(typeof prompt!=='string' || !prompt.trim()) usage('Describe what you want the agent to do.');
        const egress=input.egress ?? JOB_DEFAULTS.egress;
        if(!['internet','provider-only'].includes(egress)) usage('Egress must be internet or provider-only.');
        const source=input.git ? gitSource(input.git,input.commit) : null;
        const packaged=!input.sourceTar && input.source ? await packageSourceDirectory(input.source) : null;
        const filtered=input.sourceTar ? filterSourceArchive(input.sourceTar) : packaged;
        sourceBytes=filtered ? gzipSync(filtered.buffer) : null;
        if(input.expectedSourceDigest && (!sourceBytes || p.digestBytes(sourceBytes)!==input.expectedSourceDigest))throw Object.assign(new Error('source_changed'),{code:'source_changed',status:409});
        sourceOmissions=[...(input.sourceOmissions??[]),...(filtered?.omitted??[])];
        // `git archive` ships the last commit; tell the user what it leaves out.
        warnings=packaged?.uncommitted?.length ? ['Uncommitted changes are NOT included (only the last commit is sent). Commit them to include them: '+
          packaged.uncommitted.slice(0,20).join(', ')+(packaged.uncommitted.length>20?', and '+(packaged.uncommitted.length-20)+' more':'')] : [];
        warnings.push(...sourceOmissionLines(sourceOmissions));
        sourceManifest=filtered ? buildSourceManifest(filtered.buffer,{omitted:sourceOmissions}) : null;
        const projectName=(input.sourceLabel || (input.source?basename(resolve(input.source)):null))?.replace(/ \(folder(?:, with uncommitted changes)?\)$/,'');
        promptBytes=Buffer.from(prompt,'utf8');
        const reuseFields={source:source ?? (sourceBytes?p.digestBytes(sourceBytes):NO_SOURCE),prompt:p.digestBytes(promptBytes),
          harness:input.harness ?? null,model:input.model ?? null,...(input.working_directory!==undefined?{working_directory:input.working_directory}:{}),egress,
          ...(designated?{designated_member:designated}:{}),
          runRequest,...(verify?{verify}:{}),...(typed?{result:typed}:{})};
        const fingerprint=p.digest({...reuseFields,...(freezeAudience?{freezeAudience:true}:{})});
        slot??='submit:'+fingerprint;
        intent=await store.get(slot);
        // Earlier content keys omitted the signed request. Reuse that operation only when
        // its existing request matches; an old job without a request is never filled in.
        if(!intent&&!draftId){
          const {runRequest:requested,...oldFields}=reuseFields;
          const oldKeys=[p.digest({...oldFields,...(freezeAudience?{freezeAudience:true}:{})}),p.digest(oldFields)];
          for(const key of new Set(oldKeys)){
            const oldSlot='submit:'+key,old=await store.get(oldSlot);
            if(old?.payload?.runRequest&&p.digest(old.payload.runRequest)===p.digest(requested)){slot=oldSlot;intent=old;break;}
          }
        }
        // Older sends did not include the designated member in their slot. Recover that saved
        // request only when its signed home matches; changing homes must never reuse it.
        if(!intent&&designated){
          const {designated_member,runRequest:requested,...oldFields}=reuseFields;
          for(const fields of [{...oldFields,runRequest:requested},oldFields]){
            const oldSlot='submit:'+p.digest({...fields,...(freezeAudience?{freezeAudience:true}:{})});
            const old=await store.get(oldSlot);
            if(old?.payload?.designated_member===designated&&old.payload.runRequest&&p.digest(old.payload.runRequest)===p.digest(requested)){
              slot=oldSlot;intent=old;break;
            }
          }
        }
        if(freezeAudience&&!intent){
          const legacySlot='submit:'+p.digest(reuseFields),legacy=await store.get(legacySlot);
          if(legacy&&Boolean(legacy.payload?.audience)){slot=legacySlot;intent=legacy;}
        }
        if(intent&&intent.state!=='complete'&&Boolean(intent.payload?.audience)!==freezeAudience)throw Object.assign(new Error('Saved audience policy differs from this submission.'),{code:'audience_policy_changed',status:409});
        // A send without a draft id is named by what it asks for. Until its job has finished, the same ask is a retry
        // whose answer was lost (a timed-out tool call, an offline host the app has since reached): follow that job.
        if(intent?.state==='complete'&&Boolean(intent.payload?.audience)===freezeAudience&&await mayStillRun(
          await d.jobReadClient(circle.id,intent.jobDigest),
          intent.jobDigest,signal)) {
          await repairLocal();
          return withWarnings({jobDigest:intent.jobDigest,operationKey:intent.operationKey,replayed:true});
        }
        if(!intent || intent.state==='complete') {
          let presence;
          if(designated)client=await d.memberClient(circle.id,designated);
          else if(d.sendTarget){
            const target=await d.sendTarget(circle.id,{signal,harness,model:input.model,effort:runRequest.effortId,
              runRequest:input.model&&input.runRequest===undefined?undefined:runRequest});
            client=target.client;designated=target.designatedMember;presence=target.page;
          }else client=await d.client(circle.id);
          if(input.model&&input.runRequest===undefined){
            presence??=await client.fetchPresence({signal}).catch(()=>null);
            runRequest=borrowerRunRequest(input,presence?.devices?.flatMap(row=>row.account_offers??[])??[]);
          }
          const host=await client.capabilities({refresh:true,signal});
          if(freezeAudience&&!host.capabilities.includes('frozen_audience_v1'))
            throw Object.assign(new Error('host_too_old'),{code:'host_too_old',status:409});
          if(input.followup&&!host.capabilities.includes('parent_link_v1'))
            throw Object.assign(new Error('This computer must update before it can receive linked follow-ups.'),{code:'host_too_old',status:409});
          if(sourceManifest&&projectName&&!/[/\\\x00-\x1f\x7f]/.test(projectName)&&host.capabilities.includes('source_project_name_v1'))
            sourceManifest.project_name=projectName.slice(0,160);
          // A designated submit goes to that member's own store; the coordinator's presence preflight
          // governs only coordinator-dispatched jobs.
          if(harness&&!sendAnyway&&!designated&&typeof client.fetchPresence==='function') {
            let page;
            try {page=await client.fetchPresence({signal:signal?AbortSignal.any([signal,AbortSignal.timeout(3000)]):AbortSignal.timeout(3000)});}
            catch(error){if(signal?.aborted)throw error;}
            const availability=unavailableAgent(page,harness,circle.name);
            if(availability)throw Object.assign(new Error(availability.message),{code:availability.code,status:409,agentAvailability:availability});
          }
          const sourceRef=source ?? (sourceBytes ? {kind:'archive',artifact:{digest:p.digestBytes(sourceBytes),bytes:sourceBytes.length,media_type:'application/gzip'}} : {...NO_SOURCE});
          const now=(options.clock ?? (()=>Math.floor(Date.now()/1000)))();
          const snapshot=await d.rosterCache(circle.id).get();
          if(!snapshot?.current) { const e=new Error(); e.code='roster_required'; throw e; }
          const payload={schema:'faravan.job.v1',circle:circle.id,author:d.keyId,roster_epoch:snapshot.current.payload.epoch,
            intent_id:randomUUID(),created_at:iso(now),expires_at:iso(now+JOB_DEFAULTS.deadline_seconds),source:sourceRef,
            prompt:{digest:p.digestBytes(promptBytes),bytes:promptBytes.length,media_type:'text/plain'},
            ...(verify?{verify:{...verify}}:{}),...(typed?{result:{...typed}}:{}),
            ...(input.followup?{parent:{job_digest:input.followup.parentJob,result_digest:input.followup.parentResult}}:{}),
            ...(freezeAudience?{audience:{device_keys:[...new Set(snapshot.current.payload.members.map(member=>member.key_id))].sort()}}:{}),
            ...(input.working_directory?{working_directory:input.working_directory}:{}),
            requirements:{capabilities:[...(source?['filtered_git_v1']:[]),...(sourceManifest?['source_manifest_v1']:[]),...(sourceManifest?.project_name?['source_project_name_v1']:[]),...(input.working_directory?['working_directory_v1']:[]),...(verify?['verify_v1']:[]),...(typed?['results_v1']:[]),...(input.followup?['parent_link_v1']:[]),RUN_REQUEST_CAPABILITY,...(designated?[DESIGNATED_MEMBER_CAPABILITY]:[])],egress,limits:{...JOB_DEFAULTS.limits},limit_modes:{...JOB_DEFAULTS.limit_modes},
              ...(harness?{harness}:{}),},
            runRequest,
            ...(designated?{designated_member:designated}:{}),
            ...(sourceManifest?{source_manifest:sourceManifest}:{}),
            input_protection:'none',max_attempts:JOB_DEFAULTS.max_attempts};
          const localMetadata={...(sentByAgent?{sentByAgent:true}:{}),title:input.title,prompt:input.followup?deltaPrompt:prompt,...(input.followup?{parentJob:input.followup.parentJob,parentResult:input.followup.parentResult}:{}),circle:circle.id,agent:agent ?? null,model:input.model ?? null,
            ...((input.sourcePath ?? (!input.sourceLabel && input.source)) ? {sourcePath:resolve(input.sourcePath ?? input.source)} : {}),
            ...(typeof input.sourceBranch==='string'?{sourceBranch:input.sourceBranch}:{}),
            submittedAt:iso(now),source:input.sourceLabel ?? (input.noSource ? 'No files' : source ? source.url.replace(/^https:\/\//,'')+' @ '+source.commit.slice(0,8) : (input.source ? basename(resolve(input.source))+' (folder)' : 'Uploaded files'))};
          intent={kind:'submit',state:'pending',payload,envelope:p.signEnvelope('job',payload,d.deviceKey?.privateKey ?? d.deviceKey),
            jobDigest:p.digest(payload),operationKey:randomUUID(),
            artifacts:{source:sourceBytes?.toString('base64')??null,prompt:promptBytes.toString('base64')},warnings,sourceOmissions,localMetadata,...(sourceManifest?{sourceManifest}:{}),
            ...(draftRequest?{draftRequest}:{})};
          await store.set(slot,intent);
        }
      }
      // Repair from the durable intent before any send, including after a crash.
      await repairLocal();
      // The designated member's own store is the send target (owner-offline topology): the borrower's
      // unchanged signed intent is carried to the origin its signed roster records for that member,
      // and an uncertain reply replays the same bytes to the same store.
      const send=intent.payload.designated_member!==undefined
        ?await d.memberClient(circle.id,intent.payload.designated_member):client??await d.client(circle.id);
      // From here the job is saved and has its id. An answer that may not have arrived names that job, so every
      // surface can follow it while the app keeps delivering the same saved send.
      try {
        // Retry the original signed payload and original bytes, even after process restart.
        if(intent.artifacts) {
          sourceBytes=intent.artifacts.source===null?null:Buffer.from(intent.artifacts.source,'base64');
          promptBytes=Buffer.from(intent.artifacts.prompt,'base64');
          warnings=intent.warnings??[];
          sourceOmissions=intent.sourceOmissions??[];
          sourceManifest=intent.sourceManifest;
        } else if(draftId) {
          // A legacy pending send has no saved bytes. Only resolve its original
          // outcome; rebuilding it from current files would risk another job.
          const existing=await send.getJob(intent.jobDigest,{signal});
          if(existing.job_digest!==intent.jobDigest)usage('The saved draft outcome could not be confirmed.');
          await complete();
          return withWarnings({jobDigest:intent.jobDigest,operationKey:intent.operationKey,replayed:true});
        }
        const acceptedEpoch=(await d.rosterCache(circle.id).get()).current.payload.epoch;
        if(intent.payload.roster_epoch!==acceptedEpoch) {
          // A roster advance must not rewrite an already signed, possibly accepted intent.
          const existing=await send.getJob(intent.jobDigest,{signal});
          if(existing.job_digest===intent.jobDigest) {
            await complete();
            return withWarnings({jobDigest:intent.jobDigest,operationKey:intent.operationKey,replayed:true});
          }
        }
        await checkRecipient();
        if(sourceBytes) {
          // Older pending intents can contain an unfiltered, already signed archive. Do not
          // rewrite its digest or resend it; resolve an accepted job, otherwise refuse.
          const unsafe=[...filterSourceArchive(sourceBytes).omitted,
            ...(intent.payload.source_manifest?.not_sent??[]).filter(file=>typeof file.path==='string')];
          if(unsafe.length) {
            try {
              const existing=await send.getJob(intent.jobDigest,{signal});
              if(existing.job_digest===intent.jobDigest) {
                await complete();
                return withWarnings({jobDigest:intent.jobDigest,operationKey:intent.operationKey,replayed:true});
              }
            } catch(error) { if(error.status!==404) throw error; }
            usage('This saved send includes excluded files or their names: '+sourceOmissionLines(unsafe).join(' · ')+'. It will not be uploaded again. Review the original job before starting a new one.');
          }
          await send.uploadArtifact(sourceBytes,'application/gzip',{signal});
        }
        await send.uploadArtifact(promptBytes,'text/plain',{signal});
        await checkRecipient();
        const result=await send.submitJob(intent.payload,{signal,idempotencyKey:intent.operationKey});
        await complete(); return withWarnings(result);
      } catch(error) {
        if(error&&typeof error==='object'&&error.outcome==='unknown')error.jobDigest??=intent.jobDigest;
        throw error;
      }
      });
    },
    resolve: async input => { const {digest,circle}=await locate(input); return {digest,circle:circle.id}; },
    async current(input = {}) {
      const d = await device(), candidates = [];
      const circles = input.circle ? [await d.selectCircle(input.circle)] : await d.listCircles();
      for (const circle of circles.filter(c => c.origin)) {
        const own = new Set((await d.intentStore(circle.id).list()).filter(i => i?.jobDigest).map(i => i.jobDigest));
        for await (const view of (await d.client(circle.id)).listJobs({}))
          if (own.has(view.job_digest) && view.job?.payload?.author === d.keyId && (['queued','claimed'].includes(view.state) || statusLabel(view) === 'Stopping'))
            candidates.push({digest:view.job_digest,circle:circle.id});
      }
      if (candidates.length !== 1) usage(candidates.length ? 'More than one job is active. Choose one: faravan stop JOB-ID.\n' +
        candidates.map(j => '  ' + shortId(j.digest)).join('\n') : 'No active job sent from this device. Use faravan stop JOB-ID.');
      return candidates[0];
    },
    async get(input,{includeWaitingPresence=true,...opts}={}) {
      const {d,client,circle,digest}=await locate(input,{readJob:true});
      const signed=remember(circle.id,await client.getJob(digest,opts));
      const jobHome=await jobHomeFor(d,circle)(signed);
      const attempt=signed.current_attempt, stopKey=attemptKey(circle.id,digest);
      let stopRequest=null,stopRequestReadUnavailable=false,stopReadFailed=false;
      // A graceful lender stop ends in an ordinary result, so a finished job still reads its attempt's stop request.
      const resultAccepted=['result-accepted','finished'].includes(signed.state);
      if(attempt&&typeof attempt.execution_started_at==='string'&&
        (attempt.state==='active'&&attempt.compute_stopped!==true||resultAccepted)&&
        typeof client.getStopRequest==='function') {
        try {stopRequest=await client.getStopRequest(attempt,opts);}
        catch(error) {
          if(!optionalStopReadUnavailable(error,opts.signal))throw error;
          stopReadFailed=true;
          // For a finished job the read only explains an early stop, so an outage leaves the result as it was.
          stopRequestReadUnavailable=!resultAccepted;
          // An outage keeps the Stop this instance verified for the same attempt. A newer attempt never inherits it.
          const kept=sharedStops.get(stopKey);
          if(kept&&kept.attempt_id===attempt.attempt_id&&kept.generation===attempt.generation&&kept.job_digest===digest)
            stopRequest=structuredClone(kept);
        }
        // A successful read is the current truth for this attempt: it replaces what was kept, or clears it.
        if(!stopReadFailed) {
          if(stopRequest)sharedStops.set(stopKey,structuredClone(stopRequest));
          else sharedStops.delete(stopKey);
        }
      } else sharedStops.delete(stopKey);
      const view=await withRunFacts(await withLocal(project(signed,input.includeIdentity)),signed,circle.id,d.keyId,client,opts);
      view.jobHome=jobHome;
      if(stopRequest) {view.stopRequest=stopRequest;view.status=statusLabel({...signed,stopRequest});}
      if(stopRequestReadUnavailable)view.stopRequestReadUnavailable=true;
      // Only a revision the coordinator also computes: a view whose Stop read failed lacks the Stop, so it has no such revision.
      else Object.defineProperty(view,'jobWatchRevision',{value:jobWatchRevision(signed,stopRequest)});
      if(includeWaitingPresence&&view.state==='queued' && typeof client.fetchPresence==='function') {
        try { const page=await client.fetchPresence(opts); view.presence={...page,devices:page.devices?.filter(row=>row.device!==d.keyId)};
          const availability=unavailableAgent(page,signed.job?.payload?.requirements?.harness,circle.name);
          if(availability)Object.assign(view,{waiting_reason:availability.code,waiting_message:availability.message}); }
        catch(error) { if(opts.signal?.aborted) throw error; /* Old/offline relays retain cautious waiting copy. */ }
      }
      return pinnedWait(view,signed,d,circle.id);
    },
    async waitForJobChange(input,opts={}) {
      const {client,digest}=await locate(input);
      return client.waitForJobChange(digest,opts);
    },
    async wait(input,{signal}={}) {
      const seconds=input.timeout ?? 300;
      if(!Number.isFinite(seconds) || seconds<0 || seconds>300) usage('Timeout must be between 0 and 300 seconds.');
      const {d,client,circle,digest}=await locate(input);
      const signed=remember(circle.id,seconds===0 ? await client.getJob(digest,{signal}) :
        await client.waitForJob(digest,{signal,timeoutMs:Math.max(1,Math.floor(seconds*1000)),pollMs:options.pollMs ?? 1000}));
      const view=project(signed);
      if(view.state==='queued' && typeof client.fetchPresence==='function') {
        try { const page=await client.fetchPresence({signal}); view.presence={...page,devices:page.devices?.filter(row=>row.device!==d.keyId)};
          const availability=unavailableAgent(page,signed.job?.payload?.requirements?.harness,circle.name);
          if(availability)Object.assign(view,{waiting_reason:availability.code,waiting_message:availability.message}); }
        catch(error) { if(signal?.aborted) throw error; }
      }
      return pinnedWait(view,signed,d,circle.id);
    },
    async cancel(input,{signal}={}) {
      const {d,circle,client,store,digest}=await locate(input), slot='cancel:'+digest;
      return d.withOperationLock(circle.id,async()=>{
      let intent=await store.get(slot);
      if(intent?.state==='complete') return intent.result;
      if(!intent) {
        const snapshot=await d.rosterCache(circle.id).get(), now=(options.clock ?? (()=>Math.floor(Date.now()/1000)))();
        const payload={schema:'faravan.cancellation.v1',circle:circle.id,job_digest:digest,author:d.keyId,
          roster_epoch:snapshot.current.payload.epoch,created_at:iso(now),reason:'cancelled'};
        intent={kind:'cancel',state:'pending',operationKey:randomUUID(),payload};
        await store.set(slot,intent);
      }
      try {
        const sent=await sendCancellation(d,circle,client,store,slot,intent,signal);
        intent=sent.intent;const result=sent.result;
        await store.set(slot,{...intent,state:'complete',result}); return result;
      } catch(error) {
        if(classifyHostFailure(error,{callerSignal:signal}).code!==CIRCLE_UNREACHABLE)throw error;
        return {job_digest:digest,state:'pending',requested_at:intent.payload.created_at,
          authority_revoked:false,compute_stopped:false,message:'The stop is saved here and pending delivery. The job’s computer cannot be reached.'};
      }
      });
    },
    // P17a: when the host deletes this job, and delete it now (author or owner device; a host without retention_v1 is host_too_old).
    async retention(input,{signal}={}) { const {client,digest}=await locate(input); return client.jobRetention(digest,{signal}); },
    async delete(input,{signal}={}) { const {client,digest}=await locate(input); return client.deleteJob(digest,{signal}); },
    async readResult(input,{signal}={}) {
      // fetchResult verifies signature, retained job/attempt and both artifact hashes before any write.
      const {bytes,candidate,output}=await fetchVerified(input,'fetchResult',{signal,includeMetadata:true});
      // A message result's primary text is the agent's final message: read it from the verified transcript before any write.
      const message=output?finalMessage((await fetchVerified(input,'fetchTranscript',{signal})).toString('utf8')):null;
      // Validate all typed-result names before even creating message.md or the destination.
      if(output)validateArchive(bytes,{gzip:true,requiredRoot:['faravan-output','faravan-output']});
      const temporary=!input.out;
      const writeResult=async()=>{
        let target;
        if(temporary) {
          const dir=resultsDirectory(options.home);
          await mkdir(dir,{recursive:true,mode:0o700});
          await pruneResults(dir,{now:(options.clock ?? (()=>Math.floor(Date.now()/1000)))()*1000});
          target=await mkdtemp(join(dir,'result-'));
        } else target=await emptyDestination(input.out);
        let wroteMessage=false;
        try {
          // Namespace preflight excludes a collision with message.md; the exclusive write also protects local files.
          if(message){await writeFile(join(target,MESSAGE_FILE),message+'\n',{flag:'wx',mode:0o600});wroteMessage=true;}
          if(candidate.media_type==='application/gzip') await extractArchive(bytes,target,{gzip:true,...(output?{requiredRoot:['faravan-output','faravan-output']}:{})});
          else if(candidate.media_type==='text/x-diff') await writeFile(join(target,'changes.patch'),bytes,{flag:'wx',mode:0o600});
          else { const error=new Error(); error.code='invalid_content_type'; throw error; }
          return {status:'Result ready',preview:message?message.slice(0,4096):await previewAt(target),path:target,
            ...(output?{output:{...output},message_path:message?join(target,MESSAGE_FILE):null}:{})};
        } catch(error) {
          if(temporary) await rm(target,{recursive:true,force:true});
          else if(wroteMessage) await rm(join(target,MESSAGE_FILE),{force:true});
          throw error;
        }
      };
      // Explicit output paths can also be inside the profile. Keep every result
      // write under its gate, after the network reads and verification finish.
      return withProfileWriter(resolve(options.home ?? configHome()), writeResult);
    },
    async list(input={},opts={}) {
      return (await listWithCoverage(input,{...opts,memberFallback:false})).items;
    },
    listWithCoverage,
  };
}
export function parse(argv,allowed,bools=[]) {
  const flags={},position=[];
  for(let i=0;i<argv.length;i++) {
    const value=argv[i];
    if(value==='--lan'&&allowed.includes('lan')) {if(flags.lan) usage('Duplicate --lan.');flags.lan=true;continue;}
    if(value==='--accept-lan-warning'&&allowed.includes('accept-lan-warning')) {if(flags['accept-lan-warning']) usage('Duplicate --accept-lan-warning.');flags['accept-lan-warning']=true;continue;}
    if(value==='--json') { if(flags.json) usage('Duplicate --json.'); flags.json=true; continue; }
    if(value.startsWith('--') && bools.includes(value.slice(2))) {
      const key=value.slice(2);
      if(Object.hasOwn(flags,key)) usage('Duplicate '+value+'.');
      flags[key]=true; continue;
    }
    if(value.startsWith('--')) {
      const key=value.slice(2);
      if(!allowed.includes(key) || Object.hasOwn(flags,key)) usage('Unknown or duplicate option.');
      if(i+1===argv.length || argv[i+1].startsWith('--')) usage('Missing value for '+value);
      flags[key]=argv[++i];
    } else position.push(value);
  }
  return {flags,position};
}
// Only an owner who approves each device by hand makes the joiner wait for a person.
export function joinMessage(circle) {
  const {phase,invitationPolicy}=projectMembership(circle);
  if(phase==='approved') return 'Circle joined: '+circle.name+'.';
  if(phase==='expired') return 'This invitation has expired. Ask for a new invitation, then run faravan circle join with it.';
  if(phase==='rejected') return 'This membership request was declined. Ask for a new invitation, then run faravan circle join with it.';
  const info=circle?.joinInfo??{};
  if(phase==='unknown'&&circle?.joinIntent?.outcome==='unknown')
    return 'Could not reach the circle host. This saved join will retry with the same invitation.';
  if(phase==='unknown') return 'Membership is not confirmed yet: '+circle.name+'. Check the circle status before sending.';
  if(invitationPolicy==='unknown') return 'Not approved yet: '+circle.name+'. The approval policy is unknown. Check the circle status or ask the owner how to join.';
  if(invitationPolicy==='each') return 'Waiting for '+(info.ownerName??'the owner of '+circle.name)+' to approve this computer.'+(info.code?'\nMatch code: '+info.code+' (the owner sees the same code).':'');
  return 'Not approved yet: '+circle.name+'. The owner\'s computer approves it when it is online; run this command again later to check.';
}
// A LAN invite sends this device's enrollment over an unencrypted local network.
// Joining needs --accept-lan-warning, or an interactive "yes" on a terminal
// (never in --json mode, which must not block on input).
async function confirmLan(warning,accepted,{json,stderr,stdin}) {
  if(!json) stderr.write(warning+'\n');
  if(accepted) return;
  if(!json&&stdin.isTTY) {
    stderr.write('Join anyway? Type "yes" to continue: ');
    const {createInterface}=await import('node:readline');
    const rl=createInterface({input:stdin,terminal:false});
    const answer=await new Promise(done=>{rl.once('line',done);rl.once('close',()=>done(''));});
    rl.close();
    if(answer.trim().toLowerCase()==='yes') return;
  }
  usage((json ? warning+' ' : '')+'Rerun with --accept-lan-warning to join anyway.');
}
export async function runV1Command(argv,options={}) {
  const stdout=options.stdout ?? process.stdout, stderr=options.stderr ?? process.stderr;
  const json=argv.includes('--json');
  try {
    const [verb,action,...rest]=argv;
    if(verb==='accounts' && wantsHelp(argv)) {
      stdout.write('faravan accounts add claude --label NAME\nRead a setup token or API key from standard input.\nfaravan accounts list\nfaravan accounts check KEY\nCheck scoped sign-in without a model call.\nfaravan accounts remove claude --label NAME\nDisable the account and delete its saved token.\n');return 0;
    }
    if(wantsHelp(argv) || verb==='help') {
      const path=(verb==='help'?argv.slice(1):argv).filter(a=>!a.startsWith('-')).slice(0,2);
      const text=helpFor(path);
      if(text===null) usage('Unknown command. Run faravan --help.');
      stdout.write(text); return 0;
    }
    if(verb==='accounts') {
      const {runAccountsCommand}=await import('./accounts-cli.mjs');
      return await runAccountsCommand(argv.slice(1),options);
    }
    if(verb==='join') return runV1Command(['circle','join',...argv.slice(1)],options);
    if(verb==='stop') {
      const {flags,position}=parse(argv.slice(1),['circle']);
      if(position.length>1) usage('Usage: faravan stop [JOB-ID] [--circle NAME]');
      const ops=options.operations ?? createJobOperations(options);
      const target=position.length ? {digest:position[0],circle:flags.circle} : await ops.current({circle:flags.circle});
      return runV1Command(['job','cancel',target.digest,...(target.circle?['--circle',target.circle]:[]),...(json?['--json']:[])],{...options,operations:ops});
    }
    if(verb==='run') {
      const {runJob}=await import('./run.mjs'); return await runJob(argv.slice(1),options);
    }
    if(verb==='status') {
      // The registry routes `status get`; this legacy command always keeps the
      // ordinary device/circles/lending/jobs/disk status shape, even during retry.
      const {showStatus}=await import('./status.mjs'); return await showStatus(argv.slice(1),options);
    }
    if(verb==='name') {
      const {position}=parse(argv.slice(1),[]);
      if(position.length>1) usage('Usage: faravan name ["Your name"] (quote a name with spaces)');
      const d=await (options.device ?? openDevice(options));
      const name=position.length?await d.setOwnerName(position[0]):d.ownerName();
      stdout.write(json?JSON.stringify({name})+'\n':(position.length?'Saved. New invitations say: ':'Invitations say: ')+name+' invited you.\n');
      return 0;
    }
    if(verb==='app') {
      const {residentQuit,setResidentQuit}=await import('./resident-intent.mjs');
      const {configHome}=await import('../local-state.mjs');
      const residentHome=options.home??configHome();
      const automatic=options.residentAutostart??((options.env??process.env).FARAVAN_RESIDENT_AUTOSTART==='1');
      if(automatic&&residentQuit(residentHome))return 0;
      const {flags,position}=parse(argv.slice(1),['port']);
      if(position.length) usage('Usage: faravan app [--port PORT]');
      const port=flags.port===undefined?0:Number(flags.port);
      if(!Number.isInteger(port)||port<0||port>65535) usage('Port must be between 0 and 65535.');
      if(!automatic)setResidentQuit(false,residentHome);
      let app,stopping=false;
      const stop=()=>{
        if(stopping)return;stopping=true;
        if(app)app.close().catch(()=>{}).finally(()=>process.exit(0));
      };
      // The app publishes app.json during startup. Install the service signal handlers first so
      // a launcher that sees that record cannot terminate us before shutdown becomes available.
      // A resident owner and a service manager can signal the same shutdown.
      // Keep the idempotent handler installed until cleanup has finished.
      if(!options.signal){process.on('SIGTERM',stop);process.on('SIGINT',stop);}
      try {
        const {startApp}=await import('./app.mjs');
        app=await (options.startApp??startApp)({...options,port});
      } catch(error) {
        if(!options.signal){process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);}
        throw error;
      }
      if(stopping){await app.close();return 0;}
      // Never put a handoff code in output or a long-lived token in service logs.
      const env=options.env??process.env;
      const opener=options.openUrl??(stdout.isTTY&&!json?(await import('./open-url.mjs')).openUrl:null);
      let opened=false;
      if(!env.FARAVAN_NO_BROWSER&&typeof opener==='function') {
        try{opened=await opener(app.handoffUrl())!==false;}catch{/* Terminal fallback below; never log a handoff error containing its URL. */}
      }
      // A terminal that cannot open a browser gets a one-use handoff link. Only a terminal sees a code; everything else gets the bare origin.
      const printable=!opened&&stdout.isTTY?app.handoffUrl():app.origin+'/';
      stdout.write(json?JSON.stringify({url:printable})+'\n':'Open Faravan: '+printable+'\nIf the page asks you to reconnect, run faravan app open-link.\n');
      if(options.signal) {
        if(options.signal.aborted) await app.close();
        else options.signal.addEventListener('abort',()=>{app.close().catch(()=>{});},{once:true});
      }
      options.onApp?.(app);
      // Run as a service (systemd sends SIGTERM): shut down cleanly so the
      // lender drains and the discovery file is removed.
      return 0;
    }
    if(verb==='mcp') {
      const roots=[];const rest=argv.slice(1),extra={};
      const {runMcpServer,parseToolsets}=await import('./mcp.mjs');
      for(let i=0;i<rest.length;i++){
        if(rest[i]==='--root'&&rest[i+1])roots.push(rest[++i]);
        else if(rest[i]==='--toolsets'&&rest[i+1])extra.toolsets=parseToolsets(rest[++i]);
        else if(rest[i]==='--read-only')extra.readOnly=true;
        else if(rest[i]==='--output-schemas')extra.outputSchemas=true;
        else usage('Usage: faravan mcp [--toolsets SET] [--read-only] [--output-schemas] [--root <folder>]...');
      }
      await runMcpServer({...options,...extra,...(roots.length?{roots}:{})}); return 0;
    }
    if(verb==='apply') {
      // Accept the short job ID that run and job print; apply itself wants the full digest and circle.
      const args=argv.slice(1), at=args.findIndex((v,k)=>!v.startsWith('--')&&!['--branch','--circle'].includes(args[k-1]));
      if(at>=0&&!isFullDigest(args[at])) {
        const ci=args.indexOf('--circle'), ops=options.operations ?? createJobOperations(options);
        const found=await ops.resolve({digest:args[at],...(ci>=0?{circle:args[ci+1]}:{})});
        args[at]=found.digest; if(ci<0) args.push('--circle',found.circle);
      }
      return await (await import('./apply.mjs')).runApply(args,{...options,stdout,stderr});
    }
    if(verb==='lending') {
      const {position}=parse(rest,[]);
      if(action!=='log'||position.length) usage('Usage: faravan lending log [--json]');
      // Read straight from this home: the log is local, and viewing it needs no running app or circle.
      const entries=await readLendingLog(join(resolve(options.home ?? configHome()),'v1'));
      stdout.write(json?JSON.stringify(entries)+'\n':entries.length?entries.map(e=>
        e.at.replace('T',' ').replace(/\.\d+Z$/,'Z')+'  '+(e.title??(e.job?shortId(e.job):'unknown job'))+'  '+(e.code??'unknown')+(e.phase?' ('+e.phase+')':'')+'\n    '+e.message+'\n    ID '+(e.correlation_id??e.error_id)).join('\n')+'\n':'No problems recorded.\n');
      return 0;
    }
    if(verb==='uninstall') {
      const {runUninstall}=await import('./uninstall.mjs');
      return await runUninstall(argv.slice(1),{...options,stdout,stderr});
    }
    let result, human;
    if(verb==='circle') {
      const allowed={create:['name','lan'],invite:['circle'],join:['name','accept-lan-warning'],approve:['circle','device'],list:[]}[action];
      if(!allowed) usage('Usage: faravan circle create|invite|join|approve|list');
      const {flags,position}=parse(rest,allowed);
      if(action==='create' ? position.length>1 : position.length!==(action==='join'?1:0)) usage('Check the circle command arguments.');
      const d=await (options.device ?? openDevice(options));
      if(action==='create') {
        const {hostingView}=await import('./hosting-view.mjs');
        const {coordinatorHome}=await import('../host.mjs');
        const appHome=options.home??configHome();
        const hostHome=options.coordinatorHome??coordinatorHome({appHome});
        const hosted=await hostingView({home:hostHome,device:d,presence:async()=>({devices:[]})});
        // An unreadable host config cannot say whether this address is the hosted one: refuse rather than treat it as "not hosting".
        if (hosted.unreadable) throw Object.assign(new Error(hosted.unreadable.reason),{code:'host_config_unreadable'});
        if (!position[0] || hosted.configured && position[0]===hosted.origin) {
          if (!hosted.configured) usage('Start hosting first with faravan host, then create another circle.');
          const {hostCommand}=await import('./host-command.mjs');
          const started=await hostCommand({home:appHome,coordinatorHome:hostHome},['--new-circle','--name',flags.name??'My circle'],'host_ready');
          result=await d.selectCircle(started.circle_id);
        } else result=await d.createCircle(position[0],{name:flags.name,lanMode:flags.lan===true});
        human=(result.publicationPending?'Circle created locally: ':'Circle ready: ')+result.name+
          (position[0]&&(!hosted.configured||position[0]!==hosted.origin)&&result.provisioningCommand?'\nServer setup: '+result.provisioningCommand:'');
      }
      if(action==='list') { result=(await d.listCircles()).map(c=>({...c,membershipProjection:projectMembership(c)})); human=result.map(c=>c.name+' ('+c.id+') · '+c.membershipProjection.phase).join('\n') || 'No circles.'; }
      if(action==='join') { const joined=await d.joinCircle(position[0],{...(flags.name===undefined?{}:{deviceName:flags.name}),waitMs:options.joinWaitMs ?? Number(process.env.FARAVAN_JOIN_WAIT_MS ?? 8000),onWarning:warning=>confirmLan(warning,flags['accept-lan-warning']===true,{json,stderr,stdin:options.stdin ?? process.stdin})}); result={...joined,membershipProjection:projectMembership(joined)};human=joinMessage(joined); }
      if(action==='invite') {
        const c=await d.selectCircle(flags.circle),links=await d.createInviteLinks(c.id);
        result={invite:links.short??links.long,...(links.note?{note:links.note}:{})}; human=result.invite+(links.note?'\n'+links.note:'');
      }
      if(action==='approve') { const c=await d.selectCircle(flags.circle); result=await (flags.device===undefined?d.approveEnrollments(c.id):d.approveByCode(c.id,flags.device)); human='Approved '+result.approved.length+' circle membership request(s); '+result.rejected.length+' could not be verified.'+
        result.approvedDevices.map(x=>'\n  '+(x.device_name??'Unnamed computer')+'  '+x.key_id).join(''); }
    } else if(verb==='job') {
      const allowed={submit:['source','git','prompt','prompt-file','harness','model','effort','budget-v1','auto','egress','circle','verify-cmd','send-anyway','freeze-audience','result','designated-member'],status:['circle'],wait:['circle','timeout'],
        cancel:['circle'],result:['circle','out'],list:['circle']}[action];
      if(!allowed) usage('Usage: faravan job submit|status|wait|cancel|result|list');
      const {flags,position}=parse(rest,allowed,action==='submit'?['send-anyway','freeze-audience','yes','no-source']:[]);
      const expects=['status','wait','cancel','result'].includes(action)?1:0;
      if(position.length!==expects) usage(expects?'Provide a job ID. Run faravan job '+action+' --help.':'Check the job command arguments. Run faravan job '+action+' --help.');
      if(action==='result' && !flags.out) usage('Use --out with an empty result directory.');
      const ops=options.operations ?? createJobOperations(options), input={...flags,...(expects?{digest:position[0]}:{})};
      if(action==='submit') {
        if([flags.source,flags.git,flags['no-source']].filter(Boolean).length!==1 || (flags.prompt!==undefined)===(flags['prompt-file']!==undefined))
          usage('Choose exactly one source and one prompt. Run faravan job submit --help.');
        if(flags['no-source']){delete input['no-source'];input.noSource=true;}
        if(flags.result!==undefined)input.result={kind:flags.result};
        // --effort is only shorthand for the existing signed budget_v1.effort.
        // --budget-v1 accepts that same JSON object; no monetary default is added.
        if(flags['budget-v1']!==undefined) {
          try { input.budget_v1=JSON.parse(flags['budget-v1']); }
          catch { usage('--budget-v1 must be a JSON budget object.'); }
          requestedBudget(input);
          delete input['budget-v1'];
        }
        if(flags.effort!==undefined) {
          if(input.budget_v1?.effort!==undefined&&input.budget_v1.effort!==flags.effort)
            usage('--effort conflicts with --budget-v1 effort.');
          input.budget_v1={...input.budget_v1,effort:flags.effort};
          delete input.effort;
        }
        if(flags.auto!==undefined)usage('Choose a model and effort instead of --auto.');
        borrowerRunRequest(input);
        agentChoices(flags.harness);
        if(flags.yes!==true&&!options.operations){
          const {createOpsClient}=await import('./ops/execute.mjs');
          const client=options.opsClient??createOpsClient({home:options.home??configHome(),surface:'cli'});
          const request={prompt:flags.prompt??await readFile(resolve(flags['prompt-file']),'utf8'),
            ...(flags.source?{repo:{path:resolve(flags.source)}}:flags.git?{git:gitSource(flags.git)}:{noSource:true}),
            ...Object.fromEntries(['circle','harness','model','egress','budget_v1','auto_run_v1','result'].filter(k=>input[k]!==undefined).map(k=>[k,input[k]])),
            ...(flags['send-anyway']?{send_anyway:true}:{}),...(flags['freeze-audience']?{freeze_audience:true}:{}),
            ...(flags['verify-cmd']?{verify:{cmd:flags['verify-cmd']}}:{}),
            ...(flags['designated-member']?{designated_member:flags['designated-member']}:{})};
          let result;
          try {result=await client.call('jobs.submit',request,{confirmed:flags.yes===true,signal:options.signal});}
          catch(error){
            if(error.code!=='confirmation_required')throw error;
            await confirmJobSend(error.effect,flags.yes,options);
            result=await client.call('jobs.submit',{...request,...error.confirmation_input},{confirmed:true,signal:options.signal});
          }
          stdout.write(JSON.stringify(result)+'\n');return 0;
        }
        let circle=flags.circle;
        if (!input.circle || (flags.yes!==true && (options.stdin??process.stdin).isTTY)) {
          const d=options.device??await openDevice(options), prepared=resolveJobRecipient(input,await defaultJobCircles(d,options.home ?? configHome()));
          Object.assign(input,prepared.input); circle=prepared.circle.name??prepared.circle.id;
        }
        const effect=jobSendEffect({circle,...(flags.git?{git:gitSource(flags.git)}:flags['no-source']?{noSource:true}:{source:resolve(flags.source)})});
        await confirmJobSend(effect,flags.yes,options);
        if(input.expected_circle_id) resolveJobRecipient(input,await defaultJobCircles(options.device??await openDevice(options),options.home ?? configHome()));
        delete input.yes;
      }
      if(flags.timeout!==undefined) input.timeout=Number(flags.timeout);
      result=await ops[({status:'get',result:'readResult'})[action] ?? action](input,{signal:options.signal});
      if(action==='submit'&&!json) {
        for(const w of result.warnings??[]) stderr.write('faravan: '+w+'\n');
        if(result.sourceOmissions?.length===0) stderr.write('faravan: 0 files not sent by filename rules\n');
        if(result.sourceManifest) stderr.write('faravan: Sending '+result.sourceManifest.file_count+' files · '+result.sourceManifest.packed_bytes+' bytes packed · filename rules only; contents not scanned.\n');
      }
      human=action==='submit'?'Job submitted: '+shortId(result.jobDigest):
        action==='result'?'Result ready: '+result.path:
        action==='cancel'?(result.state==='pending'?result.message:result.compute_stopped?'Cancelled':'Stop requested'):
        action==='list'?result.map(v=>shortId(v.job_digest)+'  '+(v.waiting_reason?statusMessage(v):v.status)).join('\n') || 'No jobs.':
        statusMessage(result)+'\nJob: '+shortId(result.job_digest);
    } else usage('Unknown command. Run faravan --help.');
    if(json) stdout.write(JSON.stringify(result)+'\n'); else stdout.write(human+'\n');
    return 0;
  } catch(error) {
    const problem=problemForError(error);
    if(error?.code==='circle_not_provisioned' && typeof error.provisioningCommand==='string') stderr.write('Server setup: '+error.provisioningCommand+'\n');
    if(json) stdout.write(JSON.stringify(problem)+'\n');
    else stderr.write('faravan: '+problemText(problem)+'\n');
    return exitCodeForError(error);
  }
}
