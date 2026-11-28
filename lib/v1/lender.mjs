import {lendingReasonCode,lendingReasonText,lendingReason,LOW_DISK_ACTION,LOW_DISK_DETAIL,giveBackCode} from './lending-reasons.mjs';
import {decideLending} from './lending-decision.mjs';
import {PROVIDER_LIMIT_STOP_ANSWER_MS, PROVIDER_LIMIT_STOP_RETURN_MS} from './lending-quota-timing.mjs';
import {sandboxRemediationLines} from '../sandbox-remediation.mjs';

import {resolveLenderRunModel, configuredModelEfforts, matchingRun} from './lending-run-model.mjs';
import { MODEL_EFFORT_PAIRS_CAPABILITY, RUN_REQUEST_CAPABILITY, DESIGNATED_MEMBER_CAPABILITY } from './versions.mjs';
import { resolveSelection, validateAccountAdvertisement, selectionSatisfies, accountsForProviders } from './run-request.mjs';
import { createTranscriptPublisher } from './live-transcript.mjs';
import {durableJsonAsync} from '../durable-write.mjs';
import {borrowedStrategyAllowed} from '../harness-spec.mjs';
import {DEFAULT_RUN_MODEL} from './lending-meter.mjs';
import {buildHandoff,lenderCredentialValues} from './continuation.mjs';
import { workspaceTranscript } from './workspace-transcript.mjs';
import { createOfferReader, matchingRule, validateStandingRules } from './offers.mjs';
import {createHash, randomUUID} from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import {mkdir, readFile, open} from 'node:fs/promises';
import {dirname, join, resolve} from 'node:path';
import { acquireProcessLock } from './lock.mjs';
import { extractSourceArchive, SOURCE_ARCHIVE_INPUT_BYTES } from '../source-archive.mjs';
import {checkNewJob, canSatisfy, canonicalize, limitRequirements } from '../protocol/index.mjs';
import {createIdOf} from './sandbox-record-owner.mjs';
import { buildValidatedJobSpec, runJob, buildTaskReceipt } from '../executor.mjs';
import { createProgressReporter } from './progress.mjs';
import { newErrorRef } from './failures.mjs';
import { lendingHours } from './lending-state.mjs';
import {stoppedAgentCheck} from './blockers.mjs';
import { agentDisplayName, waitLabel, SANDBOX_WAIT } from './lending-wait.mjs';
import { observedExecutionTime } from './state-projection.mjs';
import { agentAuthFailure } from '../harnesses/shared.mjs';
import { cleanTitle } from './job-meta.mjs';
import { requestLine } from './request-line.mjs';
import { DIFF_OUTPUT, diffstat, isGitCandidateScript } from '../git-candidate.mjs';
import { OUTPUT_DIR } from '../harnesses/job-framing.mjs';

// The v1 receipt can only hold host -> decision. When the sandbox's network log could not be read,
// "*": "unknown" says so; an empty object would read as "reached nothing".
export const UNOBSERVED_EGRESS = Object.freeze({'*':'unknown'});

// Local evidence for the release journey. Absence alone still permits
// ordinary reconciliation, but only a matching incarnation proves removal.
function observedStopRemoval(pending,receipt,attempt) {
  const observation=receipt?.removal_observation, runtimeId=pending.sbx_runtime?.id;
  if(receipt?.removed!==true||!observation?.create_incarnation||
     observation.create_incarnation!==pending.sandboxIncarnation||
     !pending.owner_scope||!runtimeId||!pending.sbx_home||!pending.sandboxId||!pending.jobId||
     receipt.sbx_home!==pending.sbx_home||receipt.sandbox_id!==pending.sandboxId||receipt.job_id!==pending.jobId||
     pending.attemptId!==attempt.attempt_id||pending.attempt?.job_digest!==attempt.job_digest||
     pending.attempt?.generation!==attempt.generation)return null;
  const before=Date.parse(observation.before_at),after=Date.parse(observation.after_at);
  if(!Number.isFinite(before)||!Number.isFinite(after)||before>after)return null;
  return {attemptId:attempt.attempt_id,jobDigest:attempt.job_digest,generation:attempt.generation,
    sandboxId:pending.sandboxId,jobId:pending.jobId,ownerScope:pending.owner_scope,
    runtimeId,create_incarnation:observation.create_incarnation,
    before_at:observation.before_at,after_at:observation.after_at};
}

// A metered finish and a pre-start release have different response shapes.
// Neither silence nor a nested refusal transfers durable recovery ownership.


// A resumed zero-use grant replaces its old reservation; prior real use remains charged.
export function reserveStandingRuleTime(history,intent,attemptId,wallMs,now) {
  const rows=history.filter(row=>row.at>now-7*86400000);
  const sameGrant=row=>row.id===intent.ruleId&&row.jobDigest===intent.jobDigest&&row.acceptedAt===intent.acceptedAt;
  if(rows.some(row=>sameGrant(row)&&row.attemptId===attemptId))return rows;
  const reusable=rows.findIndex(row=>sameGrant(row)&&(!row.attemptId||(row.finished===true&&row.ms===0)));
  const reservation={id:intent.ruleId,attemptId,jobDigest:intent.jobDigest,acceptedAt:intent.acceptedAt,
    at:now,ms:wallMs,finished:false};
  if(reusable>=0)return rows.map((row,index)=>index===reusable?reservation:row);
  return [...rows,reservation];
}

export const QUOTA_PROVIDERS = Object.freeze({'claude-code-subscription':'claude','codex':'codex'});
// The settlement label for a run that ended normally. It is a status, not a failure code.
const NORMAL_FINISH = 'done';

export const RUN_FLAGS=Object.freeze(Object.assign(Object.create(null),{
  codex:({model,effort}={})=>[...(model?['-m',model]:[]),...(effort?['-c','model_reasoning_effort='+effort]:[])],
  'claude-code-subscription':({model,effort}={})=>[...(model?['--model',model]:[]),...(effort?['--effort',effort]:[])],
  'claude-code-api-key':({model,effort}={})=>[...(model?['--model',model]:[]),...(effort?['--effort',effort]:[])],
  gemini:({model}={})=>model?['-m',model]:[],
  opencode:({model}={})=>model?['-m',model]:[],
}));

// What one adapter can lend. The claim advertisement and the heartbeat both read this, so the circle is offered only pairs the
// lender would claim. lendable: the models a pace-50 candidate may lend (null: no filter). budget: whether effort jobs
// (budget_v1) can run here, which needs a quota provider and a stop control. pairs: the configured pairs lendable allows.
export function lendableModelEfforts(adapter,{lendingRuntime=null,backend}={}) {
  const lendable=null;
  const budget=Boolean(lendingRuntime&&QUOTA_PROVIDERS[adapter.spec.harness_id]&&typeof backend?.requestStop==='function');
  const cap=lendingRuntime?.effortMax?.()??'high';
  // The owner's explicit pairs above the cap are not offered. A scalar default is lowered to the cap instead.
  const configured=configuredModelEfforts(adapter).filter(p=>lendable===null||lendable.includes(p.model));
  const pairs=configured.map(p=>adapter.run?.model_efforts===undefined&&effortAbove(p.effort,cap)?{...p,effort:cap}:p)
    .filter(p=>!effortAbove(p.effort,cap));
  // beforeCap: the same pairs without the cap, so an automatic choice can say the cap changed it.
  return {lendable,budget,pairs,beforeCap:configured};
}
const EFFORT_LEVELS=['none','minimal','low','medium','high','xhigh','max'];
function effortAbove(effort,cap) {return EFFORT_LEVELS.indexOf(effort)>EFFORT_LEVELS.indexOf(cap);}

export {configuredModelEfforts} from './lending-run-model.mjs';

// The coordinator intersects the claim with its latest heartbeat. Send one
// tuple so the tuple it admits is the one priced and executed after the claim.
function claimAdvertisement(advertisement,job=null,index=0) {
  // A claim with no job in view could be given any job, and it round-robins pairs. It must never be given an automatic one.

  if(!advertisement.model_efforts?.length)return advertisement;
  const selected=job?matchingRun(advertisement,job):advertisement.model_efforts[index%advertisement.model_efforts.length];
  if(job?.budget_v1?.effort===undefined&&job)return advertisement;
  const pair=selected&&advertisement.model_efforts.find(p=>p.model===selected.model&&p.effort===selected.effort);
  return {...advertisement,model_efforts:pair?[pair]:[]};
}

// Keys stay scoped to their circle. A local name never changes accounting.
export const requesterCounterKey = (circle,keyId) => JSON.stringify([circle,keyId]);
const dayFormatters=new Map();
export const lenderDayKey = (at,timeZone=Intl.DateTimeFormat().resolvedOptions().timeZone) => {
  let formatter=dayFormatters.get(timeZone);
  if(!formatter){formatter=new Intl.DateTimeFormat('en-CA',{timeZone,year:'numeric',month:'2-digit',day:'2-digit'});dayFormatters.set(timeZone,formatter);}
  const parts=formatter.formatToParts(new Date(at)).reduce((out,p)=>(out[p.type]=p.value,out),{});
  return parts.year+'-'+parts.month+'-'+parts.day;
};
export function validateRequesterLimits(value=[]) {
  if(!Array.isArray(value)||value.length>4096)throw error('invalid_policy');
  const seen=new Set();
  return value.map(row=>{
    if(!row||typeof row!=='object'||Array.isArray(row)||
       Object.keys(row).some(k=>!['circle','keyId','dailyJobs','dailyMinutes'].includes(k))||
       typeof row.circle!=='string'||!row.circle||row.circle.length>256||
       !/^sha256:[0-9a-f]{64}$/.test(row.keyId))throw error('invalid_policy');
    const key=requesterCounterKey(row.circle,row.keyId);
    if(seen.has(key))throw error('invalid_policy');seen.add(key);
    const cap={circle:row.circle,keyId:row.keyId};
    for(const name of ['dailyJobs','dailyMinutes']) {
      const n=row[name]??null;
      if(n!==null&&(!Number.isSafeInteger(n)||n<0||n>2147483))throw error('invalid_policy');
      cap[name]=n;
    }
    return cap;
  });
}

const activeStores = new WeakSet();
const startupForeignDiagnostics = new WeakMap();
const MAX_DECLINED = 64, DECLINE_BACKOFF_MS = 3000;
// In ask mode, a job that cannot run yet must not reappear every three seconds.
// Wait five minutes before offering that same job again; other jobs can proceed.
export const TEMPORARY_HOLD_REOFFER_MS = 120000;
// After a start fails for a reason in this lender's own setup, the job is tried again after this wait, which doubles with
// each failure of the same job. A change in this lender's own readiness ends the wait sooner.
const START_RETRY_BASE_MS = 5 * 60 * 1000, START_RETRY_MAX_MS = 30 * 60 * 1000;
// An observed availability older than this is unknown. An idle lender waits in the offer long-poll (30 s) and observes
// again after it, so a healthy idle account stays well inside this bound.
const AVAILABILITY_MAX_AGE_MS = 60000;
// The final admission answer before the agent starts. Silence past this bound is a denial: no launch, no charge.
const ADMISSION_DEADLINE_MS = 60000;
const LIMITS = ['wall_seconds','cpu','memory_bytes','output_bytes'];
const CLEANUP_WAIT_LABEL = 'Waiting for cleanup of sandboxes from last time…';
const EVIDENCE_LIMIT = {wall_seconds:'wall',cpu:'cpu',memory_bytes:'memory',disk_bytes:'storage',output_bytes:'output'};
const LABELS = Object.freeze({
  paused:"Lending is paused. No new jobs will start.",
  waiting_for_sandbox:SANDBOX_WAIT,
  idle:"Lending is on. You'll be asked before each job.",
  idle_auto:'Lending is on. Jobs your lending rule allows start without asking.',
  'awaiting-approval':'This job needs your review',
  declined:'Skipped this job.',
  running:'Running',
  'sending-result':'Sending the result…',
  finished:'Finished. The borrower can review the changes.',
  failed:"This job couldn't finish.",
  stopping:'Stopping…',
  stopped:'Stopped. No more work will run for this job.',
  'limit-reached':"Today's lending limit is reached.",
  reserve:'Your remaining allowance is being kept for you.',
});
const error = code => Object.assign(new Error(code),{code});
const retryPending = e => e?.retryable===true||(e?.outcome==='unknown'&&e?.responseReceived===true)||
  e?.code==='network_error'||e?.status===429||e?.status>=500;
// Deterministic local result validation cannot succeed on replay.
const outputValidationFinal=new Set(['output_too_large','payload_too_large','model_unverified','git_commit_unverified',
  'limits_unenforceable','candidate_missing','candidate_invalid']);
const unusableCompletionAck=e=>e?.code==='invalid_response'||(e?.responseReceived===true&&e?.outcome==='unknown');
// Refusals after which a stopped report can never be recorded.
const stopReportFinal = new Set(['not_found','forbidden','stale_attempt','job_terminal','job_expired','lease_expired','lease_fenced']);
// Rejected rows retain evidence but no longer represent work to deliver.
const observationRejected=row=>row?.disposition==='rejected'&&typeof row.attempt?.attempt_id==='string'&&
  typeof row.attempt.job_digest==='string'&&Number.isSafeInteger(row.attempt.generation)&&
  typeof row.idempotencyKey==='string'&&typeof row.observedAt==='string'&&Number.isFinite(Date.parse(row.observedAt))&&
  typeof row.rejection?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(row.rejection.code)&&
  typeof row.rejection.at==='string'&&Number.isFinite(Date.parse(row.rejection.at));
const observationUnsupported=row=>row?.disposition==='unsupported'&&typeof row.attempt?.attempt_id==='string'&&
  typeof row.attempt.job_digest==='string'&&Number.isSafeInteger(row.attempt.generation)&&
  typeof row.idempotencyKey==='string'&&typeof row.observedAt==='string'&&Number.isFinite(Date.parse(row.observedAt));
// A stale observation the coordinator superseded: its try was given up with its stop, so it is settled and no proof is claimed.
const observationSuperseded=row=>row?.disposition==='superseded'&&typeof row.attempt?.attempt_id==='string'&&
  typeof row.attempt.job_digest==='string'&&Number.isSafeInteger(row.attempt.generation)&&
  typeof row.idempotencyKey==='string'&&typeof row.observedAt==='string'&&Number.isFinite(Date.parse(row.observedAt));
const observationSettled=row=>observationRejected(row)||observationUnsupported(row)||observationSuperseded(row);
export const hasPendingObservations=rows=>rows!=null&&(!Array.isArray(rows)||rows.some(row=>!observationSettled(row)));
/** Durable daily counters shared by every lender using the same canonical file. */
export function createLenderCounterStorage(file,{decorate=value=>value}={}) {
  file=resolve(file);
  let held=false;
  return {
    directory:dirname(file),
    async acquire() {
      await mkdir(dirname(file),{recursive:true,mode:0o700});
      let release;
      try {release=await acquireProcessLock(file+'.lock',{timeoutMs:0});}
      catch(e){if(e.code==='lock_busy')throw error('lender_already_running');throw e;}
      held=true;
      return ()=>{held=false;return release();};
    },
    async get() {
      try {return JSON.parse(await readFile(file,'utf8'));}
      catch(e){if(e.code==='ENOENT')return null;throw e;}
    },
    async set(value) {
      if(!held)throw error('counter_lock_required');
      await durableJsonAsync(file,decorate(value));
    },
    async retainRejectedResult(value) {
      if(!held)throw error('counter_lock_required');
      // A refusal ends transport, not ownership of the only saved output copy.
      const name=createHash('sha256').update(value.attemptId).digest('hex')+'.json';
      const path=join(dirname(file),'rejected-results',name);
      await durableJsonAsync(path,value);return path;
    },
  };
}

const quote = value => "'" + String(value).replace(/'/g, "'\\''") + "'";
const iso = ms => new Date(Math.floor(ms/1000)*1000).toISOString().replace('.000Z','Z');

/**
 * No default backend, auth flow, enrollment, provider probing, or daemon start.
 * Readiness and pure capability evidence are supplied by the integrating app.
 * clock.now is milliseconds; storage must be shared across lending contexts.
 */
export function createLender({client,backend,runAccounts=null,accountExecution=null,policy={},adapters=[],clock={},onEvent=()=>{},onDiagnostic=()=>{},onPoll=()=>{},onDecision=async()=>{},onDecisionNotApplied=async()=>{},approve,credentialValues=lenderCredentialValues,accountKey=null,accountSlot=0}={}) {
  if (!client || !backend || typeof backend.lenderCapabilities!=='function' ||
      typeof backend.admitJob!=='function' || !policy.storage?.get || !policy.storage?.set)
    throw error('lender_dependencies_required');
  const now = typeof clock==='function' ? clock : clock.now?.bind(clock) ?? Date.now;
  // The account this worker lends for. The first account of a provider is keyed by the bare provider name, which every callee
  // already assumes when no key is given, so only another account's key is passed on, whole, with the provider.
  const keyed=harness=>accountKey&&accountKey!==QUOTA_PROVIDERS[harness]?{accountKey}:{};
  const monotonic = clock.monotonic?.bind(clock) ?? ((typeof clock==='function'||clock.now)?now:()=>performance.now());
  const schedule = clock.setTimeout?.bind(clock) ?? setTimeout;
  const unschedule = clock.clearTimeout?.bind(clock) ?? clearTimeout;
  const sandboxAdmissionPending=()=>typeof backend.sandboxAdmissionPending==='function'?backend.sandboxAdmissionPending()===true:backend.deadlineRecoveryPending?.()===true;
  // Resolves to `fallback` if `pending` has not settled within `ms` on the lender's clock; a rejection passes through.
  const settleBy=(pending,ms,fallback)=>{
    let timer;
    const deadline=new Promise(resolve=>{timer=schedule(()=>resolve(fallback),ms);});
    return Promise.race([pending,deadline]).finally(()=>unschedule(timer));
  };
  const cfg = {mode:'ask',enabled:false,dailyJobs:null,dailyMinutes:null,maxWallSeconds:null,
    idleOnly:false,quotaReserve:30,quotaMaxAgeMs:60000,leaseSeconds:120,renewMs:30000,
    pollMs:1000,legacyHoldMs:60000,preparationTimeoutMs:180000,standingRules:[],timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,requesterLimits:[],...policy};
  validateRequesterLimits(cfg.requesterLimits);
  validateStandingRules(cfg.standingRules);
  for (const name of ['dailyJobs','dailyMinutes'])
    if (cfg[name]!==null&&(!Number.isSafeInteger(cfg[name])||cfg[name]<1)) throw error('invalid_policy');
  if (cfg.maxWallSeconds!==null&&(!Number.isSafeInteger(cfg.maxWallSeconds)||cfg.maxWallSeconds<1)) throw error('invalid_policy');
  for (const name of ['quotaMaxAgeMs','renewMs','pollMs','legacyHoldMs','preparationTimeoutMs'])
    if (!Number.isSafeInteger(cfg[name]) || cfg[name]<=0) throw error('invalid_policy');
  if (!['ask','auto'].includes(cfg.mode) || cfg.leaseSeconds<30 || cfg.leaseSeconds>300 ||
      cfg.renewMs>=cfg.leaseSeconds*500 || !Number.isFinite(cfg.quotaReserve) || cfg.quotaReserve<0)
    throw error('invalid_policy');
  // Single serial loop is intentional: no per-circle concurrency loophole.
  let paused=false, running=false, loop, current=null, stopsByMs=null, stoppingNow=false, stopCurrent=null, pausePreparation=null, counters=null, wake, pollController, declineUntilMono=0, pausedFrom=null;
  let state={status:'paused',label:LABELS.paused,paused:true,current:null,counters:null};
  const advisory=(callback,value)=>{try {Promise.resolve(callback(value)).catch(()=>{});} catch { /* Advisory only. */ }};
  let pollFailureDelay=0;
  const observePoll=async read=>{
    try {const result=await read();pollFailureDelay=0;advisory(onPoll,{rateLimited:false});return result;}
    catch(error){if(error.code==='rate_limited')advisory(onPoll,{rateLimited:true});throw error;}
  };
  const emit=(status,extra={})=>{
    if(extra.reason){
      if(extra.reason==='host_disk_low')extra={...extra,nextAction:LOW_DISK_ACTION,detail:LOW_DISK_DETAIL};
      const reason=lendingReasonCode(extra.reason),timed=['wait','give_back'].includes(lendingReason(reason).kind);
      const until=Number.isSafeInteger(extra.until)&&extra.until>now()?extra.until:timed?now()+120000:null;
      extra={...extra,reason,until,label:lendingReasonText(reason,{...extra,until})};
    }
    // Completion belongs to this event, not to the worker's persistent status.
    const {stopCompletion,...fields}=extra;
    state={...state,status,remediation:extra.reason==='cleanup_pending'?(state.remediation??[]):[],reason:null,until:null,nextAction:null,detail:null,label:status==='idle'&&cfg.mode==='auto'?LABELS.idle_auto:LABELS[status],paused:paused||!cfg.enabled,current:current?.attempt?.attempt_id??null,currentRequester:current?.job?.payload?.author??null,agent:current?.agent??null,
      counters:counters?structuredClone(counters):null,...fields};
    // A resumed label already carries these lines (pause keeps the label it hid), so only the missing ones are added.
    if(state.remediation.length){const missing=[...new Set(sandboxRemediationLines(state.remediation))].filter(line=>!state.label?.includes(line));if(missing.length)state.label+='\n'+missing.join('\n');}
    advisory(onEvent,structuredClone({...state,...(stopCompletion?{stopCompletion}:{})}));
  };
  const emitStopCompletion=attempt=>emit('stopped',{reason:'stopped_by_lender',stopCompletion:{
    attemptId:attempt.attempt_id,jobDigest:attempt.job_digest,generation:attempt.generation}});
  // Local observations only. Never add these fields to coordinator payloads.
  const contribution=async(kind,context=current,extra={})=>{
    const job=context?.job?.payload,attempt=context?.attempt;
    const requester=job?{circle:job.circle,keyId:job.author}:context?.requester;
    if(!requester||!attempt)return;
    advisory(onEvent,{status:'contribution',contribution:{...requester,
      jobDigest:attempt.job_digest,attemptId:attempt.attempt_id,kind,at:now(),...extra}});
  };
  // Failure sites outside the attempt catch own their diagnostic occurrence.
  const diagnose=(job,code,phase)=>{try{onDiagnostic({at:iso(now()),job,ref:newErrorRef(),code,phase});}catch{}};
  const dayKey=()=>lenderDayKey(now(),cfg.timeZone);
  // Daily caps and requester caps limit friends' jobs. A job this computer signed itself is never charged to them.
  const charged=job=>!(cfg.ownKeyId&&job?.author===cfg.ownKeyId);
  const requesterUsage=(circle,keyId)=>counters.requesters?.[requesterCounterKey(circle,keyId)]??{jobs:0,milliseconds:0};
  const requesterDelta=(circle,keyId,jobs,milliseconds)=>{
    const used=requesterUsage(circle,keyId);
    return {...counters.requesters,[requesterCounterKey(circle,keyId)]:{
      jobs:used.jobs+jobs,milliseconds:used.milliseconds+milliseconds}};
  };
  // `ran:false` records that no agent ran for this grant: the row then counts neither a job nor time against its rule.
  const ruleTime=(attemptId,ms,ran=true)=>{
    const grant=counters.pending?.ruleGrant??counters.acceptedClaim?.intent;
    return (counters.ruleUsage??[]).map(row=>
      row.attemptId===attemptId || (!row.attemptId && grant?.ruleId===row.id &&
        grant.jobDigest===row.jobDigest && grant.acceptedAt===row.acceptedAt)
        ? (({ran:_,...rest})=>({...rest,attemptId,ms,finished:true,...(ran?{}:{ran:false})}))(row) : row);
  };
  // The stamp proves prepare started no provider session. Older builds could run a
  // default agent even when their journal says dispatch was never requested.
  const pendingPreparationProof=pending=>pending.prepare_contract==='create-only'
    ? {unused:pending.executionStartRequested===false||pending.agentStartDenied===true}:null;
  // Only lender-measured time bound to this attempt and local cleanup proof can reduce a started run's time reservation.
  // Older journals or malformed evidence deliberately keep their full charge.
  const pendingTimeAdjustment=(pending,cleanupProven)=>{
    // Inferred legacy absence can read the wrong HOME on macOS. Keep the full
    // reservation charged; neither an unstarted marker nor a meter discounts it.
    if(pending.legacyFullCharge===true)return {ruleUsage:ruleTime(pending.attemptId,pending.reservedMs,true)};
    const preparation=pendingPreparationProof(pending);
    if(!preparation||pending.timeAdjustmentApplied===true)return {};
    // A denied dispatch refunded on the Stop path keeps that refund; only its rule row is left to free.
    if(pending.agentStartDenied===true&&pending.stopReason==='stopped_by_lender'&&pending.agentStartDeniedRefunded!==true)return {};
    if(pending.agentStartDenied===true&&pending.agentStartDeniedRefunded===true)return {ruleUsage:ruleTime(pending.attemptId,0,false)};
    const unstarted=preparation.unused;
    const usage=pending.actualUse;
    const reliable=usage?.attemptId===pending.attemptId&&Number.isSafeInteger(usage.ms)&&
      usage.ms>=0&&Number.isSafeInteger(pending.reservedMs)&&usage.ms<=pending.reservedMs;
    if(!unstarted&&!(reliable&&cleanupProven===true))return {};
    const actual=unstarted?0:usage.ms,refund=pending.reservedMs-actual;
    return {pending:{...pending,timeAdjustmentApplied:true},ruleUsage:ruleTime(pending.attemptId,actual,!unstarted),...(pending.charged!==false?{
      jobs:Math.max(0,counters.jobs-(unstarted?1:0)),
      milliseconds:Math.max(0,counters.milliseconds-refund),
      ...(pending.requester?{requesters:requesterDelta(pending.requester.circle,pending.requester.keyId,unstarted?-1:0,-refund)}:{})
    }:{})};
  };
  const offerReader=typeof client.listJobs==='function'&&typeof client.capabilities==='function'?createOfferReader({client,now}):null;
  const promptCache=new Map();
  let acceptedOfferResult=null,closeOffers=null;
  const claimStates=new Set(['created-unsent','sent-uncertain','confirmed','rejected','expired-unstarted','replaced','dropped']);
  // Only this process can prove invocation. A restored write-ahead record must pass fresh admission again.
  const sentClaims=new Map();
  const CLAIM_PARKED=Symbol('claim parked');
  const claimRequest=intent=>intent.request??{jobDigest:intent.jobDigest??null,advertisement:structuredClone(intent.advertisement),
    leaseSeconds:intent.leaseSeconds??cfg.leaseSeconds,idempotencyKey:intent.idempotencyKey,
    ...(!intent.jobDigest?{waitSeconds:intent.waitSeconds??30,...(intent.exclude?{exclude:structuredClone(intent.exclude)}:{})}:{})};
  const uncertainClaim=intent=>intent?.state==='sent-uncertain'&&sentClaims.get(intent.idempotencyKey)===canonicalize(claimRequest(intent));
  const claimEnd=(intent,state)=>({state,...(intent?{idempotencyKey:intent.idempotencyKey}:{}),at:iso(now())});
  // A received outcome remains authoritative if its own write fails. Carry the
  // whole record into later writes without changing the committed snapshot.
  let claimDraft=null;
  const claimIntent=intent=>claimDraft?.idempotencyKey===intent?.idempotencyKey?claimDraft:intent;
  const stageClaim=intent=>(claimDraft=intent);
  const replaceClaim=intent=>{
    const {claimResult,claimError,request,state,...fields}=intent;
    return {...fields,idempotencyKey:randomUUID(),state:'created-unsent'};
  };
  const waitingOffers=new Map(),offerReviews=new Map(),acceptedOfferReviews=new Set();
  const pendingHiddenOffers=new Map();
  // A known readiness change clears per-job cooldowns; a polling cycle alone does not.
  // A person's explicit Skip or Hide still holds until the job expires.
  const boot=randomUUID();let readinessEpoch=0,heldBack=false;
  const noteReadiness=(isReady,reason)=>{if(reason==='cleanup_pending')return;if(!isReady)heldBack=true;else if(heldBack){heldBack=false;readinessEpoch++;}};
  // A job returned for cleanup stays out of this lender's claims only while that cleanup lasts; the retry time it carries is for the host.
  // A cleanup give-back made while cleanup ran holds only until cleanup ends: its end is the readiness change. Any other
  // give-back, including cleanup_pending with no cleanup running, holds until its promised time or a readiness change.
  const excluded=row=>row.expiresAt>now()&&(row.reason==='cleanup_pending'&&row.cleanup===true?sandboxAdmissionPending():row.epoch===undefined||(row.boot===boot?row.epoch===readinessEpoch:readinessEpoch===0));
  const claimExclusions=()=>[...new Set([...(counters.hiddenOffers??[]),...(counters.declined??[])].filter(excluded).map(row=>row.jobDigest))];
  // deniedStart: the attempt whose final admission refused dispatch. Every later save of its pending record carries that fact,
  // so one failed write of the marker cannot turn a job that never ran into a charged run.
  let saving=Promise.resolve(),stopIntent=null,stopReleaseAcknowledgedKey=null,deniedStart=null;
  const save=(next,{stoppedReleaseAck=false,observationWrite=false}={})=>{
    const write=saving.then(async()=>{
      if(typeof next==='function')next=next(counters);
      if(next.claimPending&&next.claimPending.idempotencyKey===claimDraft?.idempotencyKey)
        next={...next,claimPending:claimDraft};
      if(!observationWrite&&counters?.observationPending!==undefined)
        next={...next,observationPending:counters.observationPending};
      if(next.pending&&next.pending.attemptId===counters?.pending?.attemptId)
        next={...next,pending:{...counters.pending,...next.pending}};
      if(next.pending&&next.pending.attemptId===stopIntent?.attemptId)
        next={...next,pending:{...next.pending,...stopIntent}};
      if(next.pending&&next.pending.attemptId===deniedStart&&next.pending.agentStartDenied!==true)
        next={...next,pending:{...next.pending,agentStartDenied:true}};
      // A queued snapshot cannot restore consent revoked by an explicit Stop.
      if(stopIntent?.jobDigest) {
        const digest=stopIntent.jobDigest;
        // A release acknowledgment or final refusal may clear a release-only Stop journal.
        if(counters?.declinePending?.stoppedByLender&&counters.declinePending.attempt.attempt_id===stopIntent.attemptId&&!stoppedReleaseAck)
          next={...next,declinePending:counters.declinePending};
        // Revocation and its recovery owner travel together, including after a
        // failed Stop write before preparation has created a pending record.
        if(!next.pending&&!next.declinePending&&!stoppedReleaseAck&&stopReleaseAcknowledgedKey!==stopIntent.stopReleaseKey)
          next={...next,declinePending:{attempt:stopIntent.attempt,reason:canonicalize({code:'stopped_by_lender'}),
            idempotencyKey:stopIntent.stopReleaseKey,stoppedByLender:true,stopOfferExpiresAt:stopIntent.stopOfferExpiresAt}};
        next={...next,acceptedClaim:next.acceptedClaim?.intent?.jobDigest===digest?null:next.acceptedClaim,
          claimPending:next.claimPending?.jobDigest===digest?null:next.claimPending,
          claimedPending:next.claimedPending?.attempt_id===stopIntent.attemptId?null:next.claimedPending,
          hiddenOffers:[...(next.hiddenOffers??[]).filter(row=>row.expiresAt>now()&&row.jobDigest!==digest),
            {jobDigest:digest,expiresAt:stopIntent.stopOfferExpiresAt,permanent:true,exclusionVersion:1}].slice(-10000)};
      }
      // Keep a local hide through failed writes and merge it into every later save.
      for(const [digest,expiresAt] of pendingHiddenOffers)if(expiresAt<=now())pendingHiddenOffers.delete(digest);
      if(pendingHiddenOffers.size)next={...next,hiddenOffers:[...(next.hiddenOffers??[])
        .filter(row=>row.expiresAt>now()&&!pendingHiddenOffers.has(row.jobDigest)),
        ...[...pendingHiddenOffers].map(([jobDigest,expiresAt])=>({jobDigest,expiresAt,permanent:true,exclusionVersion:1}))].slice(-10000)};
      // Neither the caller's draft nor a storage implementation may alias the
      // committed journal. Publish exactly the snapshot whose write succeeded.
      const snapshot=structuredClone(next);
      await policy.storage.set(structuredClone(snapshot));counters=snapshot;
      if(stoppedReleaseAck)stopReleaseAcknowledgedKey=stopIntent?.stopReleaseKey??null;
      if(claimDraft?.idempotencyKey!==counters.claimPending?.idempotencyKey)claimDraft=null;
      for(const key of sentClaims.keys())if(key!==counters.claimPending?.idempotencyKey)sentClaims.delete(key);
      for(const row of snapshot.hiddenOffers??[])if(pendingHiddenOffers.get(row.jobDigest)===row.expiresAt)pendingHiddenOffers.delete(row.jobDigest);
    });
    saving=write.catch(()=>{});return write;
  };
  let observationFlight=null;
  let reportedObservationFailure=null;
  function recoverObservation(signal) {
    if(!observationFlight) {
      const flight=sendObservations(signal).catch(()=>{});
      observationFlight=flight.finally(()=>{observationFlight=null;});
    }
    return observationFlight;
  }
  async function sendObservations(signal) {
    if(typeof client.observeExecutionStart!=='function')return;
      const acknowledgments=new Map();
      let delay=250;
      while(!signal?.aborted) {
        const rows=counters?.observationPending;
        if(!Array.isArray(rows))return;
        const intent=rows.find(row=>!observationSettled(row));
        if(!intent)return acknowledgments;
        let result,failure;
        try {
          const timeout=AbortSignal.timeout(3000),requestSignal=signal?AbortSignal.any([signal,timeout]):timeout;
          let abortRequest;
          const aborted=new Promise((_,reject)=>{abortRequest=()=>reject(requestSignal.reason);requestSignal.addEventListener('abort',abortRequest,{once:true});if(requestSignal.aborted)abortRequest();});
          try {result=await Promise.race([Promise.resolve().then(()=>client.observeExecutionStart(intent.attempt,{signal:requestSignal,idempotencyKey:intent.idempotencyKey,observedAt:intent.observedAt,requireLaunchAuthority:true})),aborted]);}
          finally {requestSignal.removeEventListener('abort',abortRequest);}
        } catch(e) {failure=e;}
        if(signal?.aborted)return;
        // Only a superseded reply for this exact stopped attempt, with no observation time, settles the intent.
        const superseded=!failure&&result?.observation==='superseded'&&result.attempt_id===intent.attempt?.attempt_id&&
          result.compute_stopped===true&&result.execution_observed_at==null;
        if(!failure&&result!==null&&!superseded&&(!result||typeof result.execution_observed_at!=='string'||result.observation!==undefined)) {
          if(reportedObservationFailure!==intent.idempotencyKey) {
            reportedObservationFailure=intent.idempotencyKey;
            advisory(onDiagnostic,{at:iso(now()),job:intent.attempt?.job_digest,ref:newErrorRef(),
              code:'execution_observation_failed',phase:'execution_observation',details:{attemptId:intent.attempt?.attempt_id}});
          }
          return; // A malformed local result is not a server rejection or acknowledgement.
        }
        if(failure) {
          if(failure.name==='TimeoutError')continue;
          if(retryPending(failure)||failure.status===408) {
            try {await wait(delay,signal);} catch {return;}
            delay=Math.min(delay*2,10_000);continue;
          }
          if(!Number.isInteger(failure.status)||failure.status<400||failure.status>=500) {
            if(reportedObservationFailure!==intent.idempotencyKey) {
              reportedObservationFailure=intent.idempotencyKey;
              advisory(onDiagnostic,{at:iso(now()),job:intent.attempt?.job_digest,ref:newErrorRef(),
                code:'execution_observation_failed',phase:'execution_observation',details:{attemptId:intent.attempt?.attempt_id}});
            }
            return;
          }
        }
        if(!failure&&result===null) {
          try {await save(saved=>({...saved,observationPending:(saved.observationPending??[]).map(row=>
            row.idempotencyKey===intent.idempotencyKey?{...row,disposition:'unsupported'}:row)}),{observationWrite:true});}
          catch {return;} // Keep the original pending row when the disposition was not saved.
        } else if(superseded) {
          try {await save(saved=>({...saved,observationPending:(saved.observationPending??[]).map(row=>
            row.idempotencyKey===intent.idempotencyKey?{...row,disposition:'superseded'}:row)}),{observationWrite:true});}
          catch {return;} // Keep the original pending row when the disposition was not saved.
        } else if(failure) {
          const code=typeof failure?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(failure.code)?failure.code:failure?'http_error':'not_found';
          const rejection={code,at:iso(now()),circle:cfg.observationCircle??null,...(failure?{status:failure.status}:{})};
          try {await save(saved=>({...saved,observationPending:(saved.observationPending??[]).map(row=>
            row.idempotencyKey===intent.idempotencyKey?{...row,disposition:'rejected',rejection}:row)}),{observationWrite:true});}
          catch {return;} // Keep the original pending row when the disposition was not saved.
          advisory(onDiagnostic,{at:rejection.at,job:intent.attempt?.job_digest,ref:newErrorRef(),
            code:'execution_observation_failed',phase:'execution_observation',details:{attemptId:intent.attempt?.attempt_id}});
        } else {
          try {await save(saved=>({...saved,observationPending:(saved.observationPending??[]).filter(row=>row.idempotencyKey!==intent.idempotencyKey)}),{observationWrite:true});}
          catch {return;} // An acknowledgement is safe to replay after a failed clear.
          acknowledgments.set(intent.idempotencyKey,result);
        }
        delay=250;
      }
  }
  async function restoreStopRevocation(record) {
    if(stopIntent?.attemptId===record.attempt.attempt_id)return;
    const expiry=record.stopOfferExpiresAt??Date.parse(counters.acceptedClaim?.claim?.job?.payload?.expires_at);
    stopIntent={attempt:structuredClone(record.attempt),attemptId:record.attempt.attempt_id,jobDigest:record.attempt.job_digest,stopReason:'stopped_by_lender',
      stopOfferExpiresAt:Number.isFinite(expiry)?expiry:now()+30*86400000,
      stopRequestKey:record.stopRequestKey??randomUUID(),
      stopReleaseKey:record.stopReleaseKey??record.idempotencyKey??randomUUID(),stopReportKey:record.stopReportKey??randomUUID()};
    await save(saved=>saved);
  }
  async function publishStopRequest(attempt,key,signal) {
    if(typeof client.requestStop!=='function'||!key)return false;
    try {await recoveryRequest(signal,signal=>client.requestStop(attempt,{signal,idempotencyKey:key}),3000);return true;}
    catch {return false;}
  }
  async function budget({recoveryOnly=false}={}) {
    const currentDay=dayKey();
    if (!counters) {
      let saved;
      try{saved=await policy.storage.get();}catch{throw error('invalid_counter_store');}
      if (saved!=null && (typeof saved!=='object'||Array.isArray(saved)||
          !Number.isSafeInteger(saved.jobs)||saved.jobs<0||!Number.isSafeInteger(saved.milliseconds)||saved.milliseconds<0))
        throw error('invalid_counter_store');
      const loaded=structuredClone(saved??{day:currentDay,jobs:0,milliseconds:0,pending:null});
      // Only lending-pool childStore's fresh shared-only seed has no owned window.
      // Unknown keys or journals are not evidence of a blank account.
      const sharedSeed=!Object.hasOwn(loaded,'day')&&loaded.jobs===0&&loaded.milliseconds===0&&
        loaded.pending===null&&Array.isArray(loaded.hiddenOffers)&&Array.isArray(loaded.ruleUsage)&&
        (loaded.hiddenOffers.length>0||loaded.ruleUsage.length>0||(loaded.jobConsents?.length??0)>0)&&
        Object.keys(loaded).every(key=>['jobs','milliseconds','pending','hiddenOffers','ruleUsage','jobConsents'].includes(key));
      if(sharedSeed)loaded.day=currentDay;
      const calendarDay=typeof loaded.day==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(loaded.day)
        ?new Date(loaded.day+'T00:00:00.000Z'):null;
      if(!calendarDay||!Number.isFinite(calendarDay.getTime())||calendarDay.toISOString().slice(0,10)!==loaded.day)
        throw error('invalid_counter_store');
      if(loaded.claimPending){
        if(!claimStates.has(loaded.claimPending.state??'created-unsent'))throw error('invalid_counter_store');
      }
      // Reconstruct only the bounded generic cooldown; wall corrections cannot extend it.
      declineUntilMono=monotonic()+Math.min(DECLINE_BACKOFF_MS,Math.max(0,(loaded.declineUntil??0)-now()));
      if(loaded.declined!==undefined&&(!Array.isArray(loaded.declined)||loaded.declined.length>MAX_DECLINED||
         loaded.declined.some(entry=>!/^sha256:[0-9a-f]{64}$/.test(entry.jobDigest)||!Number.isFinite(entry.expiresAt))))
        throw error('invalid_counter_store');
      if(loaded.declineUntil!==undefined&&!Number.isFinite(loaded.declineUntil))throw error('invalid_counter_store');
      if(loaded.requesters!==undefined) {
        if(!loaded.requesters||typeof loaded.requesters!=='object'||Array.isArray(loaded.requesters))throw error('invalid_counter_store');
        for(const [key,used] of Object.entries(loaded.requesters)) {
          let scope;try{scope=JSON.parse(key);}catch{throw error('invalid_counter_store');}
          if(!Array.isArray(scope)||scope.length!==2||typeof scope[0]!=='string'||!scope[0]||
             !/^sha256:[0-9a-f]{64}$/.test(scope[1])||requesterCounterKey(...scope)!==key||
             !used||!Number.isSafeInteger(used.jobs)||used.jobs<0||
             !Number.isSafeInteger(used.milliseconds)||used.milliseconds<0)throw error('invalid_counter_store');
        }
      }
      counters=loaded;
      if(sharedSeed){
        try{await save(counters);}catch(e){counters=null;throw e;}
      }
    }
    // Valid saved ownership must be recoverable even after a wall-clock reversal.
    // Recovery loading never normalizes old claim intents, rolls a day or prunes exclusions.
    if(recoveryOnly)return counters;
    // Clock reversal must not erase usage or prune saved journals.
    if(counters.day>currentDay)throw error('invalid_counter_store');
    if(counters.claimPending&&counters.claimPending.state===undefined){
      try{await save({...counters,claimPending:{...counters.claimPending,state:'created-unsent'}});}
      catch(e){counters=null;throw e;}
    }
    if(counters.day!==currentDay&&!counters.pending) await save({...counters,day:currentDay,jobs:0,milliseconds:0,requesters:{},lastRequesterLimit:null,pending:null});
    // Legacy exclusions have no cause. Keep them until expiry rather than guessing from an attempt.
    const retained=(counters.declined??[]).filter(excluded);
    if(retained.length!==(counters.declined??[]).length)await save({...counters,declined:retained});
    return counters;
  }
  async function storageWait(e,signal) {
    active(signal);forgetAdmission();
    const reason=e?.code==='invalid_counter_store'?'invalid_counter_store':
      ['ENOSPC','EDQUOT','host_disk_low'].includes(e?.code)?'host_disk_low':'storage_unavailable';
    emit('waiting_for_sandbox',{reason,label:reason==='invalid_counter_store'
      ?'Lending is waiting for valid saved counters; existing usage has not been reset.'
      :reason==='host_disk_low'?'Lending is waiting for free disk space to save its counters.'
      :'Lending is waiting for its counter storage to become available.'});
    await idle(signal);
  }
  async function readyBudget(signal,options) {
    try{await budget(options);return true;}
    catch(e){await storageWait(e,signal);return false;}
  }
  const active=signal=>{if(signal?.aborted)throw signal.reason??error('cancelled');};
  function wait(ms,signal) {
    active(signal);
    return new Promise((resolve,reject)=>{
      const done=()=>{unschedule(timer);signal?.removeEventListener('abort',stop);resolve();};
      const stop=()=>{unschedule(timer);signal?.removeEventListener('abort',stop);reject(signal.reason??error('cancelled'));};
      const timer=schedule(done,ms);signal?.addEventListener('abort',stop,{once:true});
    });
  }
  async function idle(signal,ms=cfg.pollMs) {
    const controller=new AbortController();
    const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal;
    wake=()=>controller.abort();
    try {await wait(ms,combined);}catch(e){if(signal?.aborted)throw e;}finally{wake=null;}
  }
  async function failureWait(error,signal) {
    pollFailureDelay=Math.min(pollFailureDelay?pollFailureDelay*2:cfg.pollMs,30000);
    const retryAfter=error.retryAfterSeconds;
    const serverDelay=Number.isFinite(retryAfter)&&retryAfter>=0?retryAfter*1000:0;
    await idle(signal,Math.min(2147483647,Math.max(pollFailureDelay,serverDelay)));
  }
  // Why an account cannot take a job now, from its own evidence. The sandbox is named first, as the readiness steps order
  // them. Unknown evidence is still being checked; it is never reported as signed out.
  // An agent the owner never chose is not lent: it is never "still checking", whatever its sign-in evidence.
  function unavailableReason(account) {
    if(!account)return 'no_ready_agent';
    if(account.checkFailed===true)return 'sandbox_not_ready';
    if(account.installed===false)return 'no_ready_agent';
    if(account.signedIn===false)return 'agent_signed_out';
    if(account.chosen===false)return 'lending_off';
    if(account.installed!==true||account.signedIn!==true)return 'lender_starting';
    return 'lending_off';
  }
  // The wait label follows the account's reason (lending-wait.mjs), so a signed-out agent never reads as a sandbox problem.
  function unavailable(account) {
    const reason=unavailableReason(account),harness=account?.spec?.harness_id;
    if(account?.automaticChecksStopped===true)return {reason,label:stoppedAgentCheck().detail};
    return {reason,label:waitLabel(reason,{agent:agentDisplayName(harness),
      setUp:account?.installed===true&&account?.signedIn===true})};
  }
  // Call only with payloads returned by the client’s verified offer/claim readers.
  async function ownJob(job) {
    if(!cfg.ownKeyId||job?.author!==cfg.ownKeyId)return false;
    const local=await client.resultContext();
    return job.author===local.keyId&&local.keyId===cfg.ownKeyId&&local.circle===job.circle;
  }
  // Without a verified job, this describes only capacity that can be lent.
  // Idle discovery and held-offer eligibility may reuse a reading. New claims are gated separately; execution probes fresh.
  async function offeredAccounts(adapter){
    const accounts=typeof runAccounts==='function'?accountsForProviders(runAccounts(),[adapter.accountProviderId??adapter.spec.harness_id]):null;
    return accounts;
  }
  // The host's feature list. A look at availability never fails on it: a host that does not answer is the 'circle_unreachable'
  // wait of lendingConditions, which the decision names. The answer then says `unread`, and no claim is sent from it.
  async function hostCapabilities(observing) {
    try {return await client.capabilities();}
    catch(e){if(e.status===404)return undefined;if(observing)return {unread:true};throw e;}
  }
  // Returns whether the host's feature list could not be read.
  async function currentAccountAdvertisement(adapter,advertisement,observing=false){
    const offered=await offeredAccounts(adapter);
    advertisement.capabilities=advertisement.capabilities.filter(cap=>cap!==RUN_REQUEST_CAPABILITY);
    delete advertisement.accounts;
    if(!offered?.length||!validateAccountAdvertisement(offered)||typeof client.capabilities!=='function')return false;
    const host=await hostCapabilities(observing);
    if(host?.capabilities?.includes(RUN_REQUEST_CAPABILITY)){
      advertisement.capabilities.push(RUN_REQUEST_CAPABILITY);advertisement.accounts=structuredClone(offered);
    }
    return host?.unread===true;
  }
  async function observeCapabilities(job=null,{cached=false,discoveryReport=null,observing=false}={}) {
    const owner=await ownJob(job);
    const records=typeof adapters==='function'?await adapters(owner?job:null):adapters;
    const scopedRecords=records.map(a=>{
      const ownerUsesProxy=owner&&a.lendingSpec&&a.proxySecretPresent===true;
      return {...a,spec:owner?(ownerUsesProxy?a.lendingSpec:(a.ownerSpec??a.spec)):(a.lendingSpec??a.spec),
        signedIn:owner?(ownerUsesProxy?(a.ownerSignedIn===true||a.proxySignedIn===true):(a.ownerSignedIn??a.signedIn)):(a.proxySignedIn??a.signedIn)};
    });
    const providerIds=scopedRecords.map(account=>account.accountProviderId??account.spec.harness_id);
    const brokerUnavailable=()=>({providerIds,reason:'conditions_unavailable'});

    // A harness whose only guest secret is a one-job broker key may lend through an offered broker account; its own
    // credential strategy stays owner-only for any other borrowed job (admission repeats this per job).
    const brokerOffered=a=>accountExecution?.configuredAccounts?.().some(account=>account.providerId===(a.accountProviderId??a.spec.harness_id))||typeof runAccounts==='function'&&runAccounts().some(account=>account.providerId===(a.accountProviderId??a.spec.harness_id));
    const lendableRecords=scopedRecords.filter(a=>owner||borrowedStrategyAllowed(a.spec.auth_strategy)||
      a.spec.auth_strategy==='guest-env-api-key'&&brokerOffered(a));
    // Never replay a borrowed native advertisement after upgrade. Retain its intent
    // while blocked; an uncertain claim must not be silently forgotten. A ready
    // Docker proxy runs the replayed claim, so it may replay under the same id.
    if(!owner&&counters.claimPending?.advertisement?.harnesses?.some(id=>records.some(a=>a.spec.harness_id===id&&
      (a.ownerSpec??a.spec).auth_strategy==='provider-file-generation'&&!(a.lendingSpec&&a.proxySignedIn===true))))
      return {providerIds,ownerOnly:true,reason:'native_credentials_owner_only'};
    if(records.length && !lendableRecords.length)return {providerIds,ownerOnly:true,reason:'native_credentials_owner_only'};
    const report=discoveryReport??(cached?await backend.lenderCapabilities({cached:true,observation:true,idle:true}):await backend.lenderCapabilities());
    if(!report?.available || !LIMITS.every(k=>report.enforced_limits?.includes(k)))return {providerIds,report,reason:'sandbox_check_pending'};
    const usable=lendableRecords.filter(a=>(!owner||!a.lendingSpec||typeof a.proxySecretPresent==='boolean')&&
      (accountExecution&&brokerOffered(a)||a.installed===true&&a.signedIn===true)&&
      (a.enabled!==false||owner));
    if(!usable.length) {
      if(!owner&&records.some(a=>(a.ownerSpec??a.spec).auth_strategy==='provider-file-generation'&&
        a.ownerSignedIn===true&&a.proxySignedIn!==true))return {providerIds,ownerOnly:true,reason:'native_credentials_owner_only'};
      if(!owner&&typeof runAccounts==='function')return brokerUnavailable();
      return unavailable(lendableRecords[0]);
    }
    // Advertise one adapter at a time, never union incompatible harness/model pairs.
    const adapter=usable[0];
    // With the candidate path on, Claude advertises only the models the chunk can lend.
    const {lendable,budget,pairs,beforeCap}=lendableModelEfforts(adapter,{lendingRuntime:cfg.lendingRuntime,backend});
    const wallLimits=[report.max_limits.wall_seconds];
    if(cfg.maxWallSeconds!==null)wallLimits.push(cfg.maxWallSeconds);
    if(cfg.dailyMinutes!==null)wallLimits.push(Math.max(1,Math.floor((cfg.dailyMinutes*60000-counters.milliseconds)/1000)));
    const advertisement={harnesses:[adapter.spec.harness_id],models:[...(adapter.models??[])].filter((m)=>lendable===null||lendable.includes(m)),
      // The reused executor emits a gzip tree, not a patch-output artifact. results_v1: empty
      // workspaces and faravan-output/ trees need only the executor, never a backend feature.
      capabilities:[...(report.capabilities?.includes('verify_v1')&&typeof backend.verify==='function'&&typeof backend.verificationFiles==='function'&&typeof backend.prepareCheck==='function'?['verify_v1']:[]),'results_v1','parent_link_v1','working_directory_v1','source_manifest_v1','source_project_name_v1','filtered_git_v1',...(budget?['budget_v1']:[])],
      egress:[...(report.egress??[])],enforced_limits:[...report.enforced_limits],
      max_limits:{...report.max_limits,wall_seconds:Math.min(...wallLimits)}};
    // This device's own member store is the claim authority (the roster records its serving origin):
    // its advertisement says so. The per-job designated fence at each store still decides every job.
    if(cfg.servesMember===true)advertisement.capabilities.push(DESIGNATED_MEMBER_CAPABILITY);
    // Accounts offered for a signed run request. Only an injected, valid advertisement is sent; no ambient account is ever offered.
    let hostUnread=await currentAccountAdvertisement(adapter,advertisement,observing);

    if(pairs.length&&typeof client.capabilities==='function') {
      const host=await hostCapabilities(observing);
      if(host?.unread)hostUnread=true;
      if(host?.capabilities?.includes(MODEL_EFFORT_PAIRS_CAPABILITY)) {
        advertisement.models=[...new Set([...pairs.map(p=>p.model),...advertisement.models])];
        advertisement.model_efforts=pairs.map(p=>({harness:adapter.spec.harness_id,...p}));
        advertisement.capabilities.push(MODEL_EFFORT_PAIRS_CAPABILITY);
      }
    }
    return {adapter,advertisement,report,providerIds,beforeCap:beforeCap.map(p=>({harness:adapter.spec.harness_id,...p})),...(hostUnread?{hostUnread:true}:{})};
  }
  // Observation has no policy outcome. Every configured account sees the same facts, then one reduction decides.
  async function availability(job=null,options){
    const facts=await observeCapabilities(job,options);
    const conditions=await lendingConditions(job,counters,facts);
    if(options?.startupWait)conditions.waits.unshift({reason:'cleanup_pending',nextEvaluationAtMs:now()+120000});
    let decision,accountIds;
    if(accountExecution?.availability){
      ({decision,accountIds}=await accountExecution.availability({providerIds:facts.providerIds,conditions}));
    }else{
      const at=now();
      decision=decideLending({schemaVersion:1,nowMs:at,account:{id:'local',enabled:true,authState:'signed_in'},
        usage:{accountId:'local',state:'unavailable',reading:null},ledger:{accountId:'local',resources:[]},history:{accountId:'local',rows:[]},
        policy:{revision:1,enabled:conditions.enabledNow,strategy:'automatic',strategyParams:{},protectionPosition:'balanced'},
        eligibility:{evaluatedAtMs:at,settingsRevision:1,enabledNow:conditions.enabledNow},job:null,runtime:conditions.runtime,conditions});
    }
    if(decision.kind!=='lend')return {...facts,adapter:null,decision,reason:decision.code??decision.reason,until:decision.nextEvaluationAtMs??null,nextAction:decision.nextAction??null,detail:decision.detail??null};
    if(facts.advertisement?.accounts&&accountIds)facts.advertisement.accounts=facts.advertisement.accounts.filter(a=>accountIds.includes(a.accountId));
    return {...facts,decision};
  }
  // Usable or not, as one object: the usable adapter, or null (for callers that only need a usable account).
  async function available(job=null,options) {
    const found=await availability(job,options);
    return found.adapter?found:null;
  }
  // Every claim transport passes here. Known outcomes retry local settlement, never the request.
  async function sendClaim(intent,signal) {
    intent=stageClaim({...claimIntent(intent),state:claimIntent(intent).state??'created-unsent'});
    if(!claimStates.has(intent.state))throw error('invalid_counter_store');
    if(stopIntent?.jobDigest&&stopIntent.jobDigest===intent.jobDigest)return CLAIM_PARKED;
    if(['dropped','replaced'].includes(intent.state)){
      await save({...counters,claimPending:null,lastClaimOutcome:claimEnd(intent,intent.state)});return CLAIM_PARKED;
    }
    if(['confirmed','rejected','expired-unstarted'].includes(intent.state)){
      const attempt=intent.claimResult?.attempt;
      if(intent.state==='confirmed'&&intent.jobDigest&&attempt&&observedExecutionTime(attempt)===null&&Date.parse(attempt.lease_expires_at)<=now())
        intent=stageClaim({...intent,state:'expired-unstarted',claimError:{code:'lease_expired',status:409,committedAttempt:structuredClone(attempt)}});
      await save({...counters,claimPending:intent});
      if(intent.state==='confirmed')return structuredClone(intent.claimResult);
      throw Object.assign(error(intent.claimError.code),intent.claimError,{claimRejected:intent.state==='rejected'});
    }
    const request=claimRequest(intent),fingerprint=canonicalize(request);
    if(request.idempotencyKey!==intent.idempotencyKey)throw error('invalid_counter_store');
    if(!uncertainClaim(intent)){
      intent=stageClaim({...intent,request,state:'sent-uncertain'});
      // This durable checkpoint is not proof of send; a crash here is conservatively rechecked on startup.
      await save({...counters,claimPending:intent});
      if(counters.claimPending?.idempotencyKey!==intent.idempotencyKey)return CLAIM_PARKED;
      let report;
      try{report=await backend.lenderCapabilities();}catch{report=null;}
      if(counters.claimPending?.idempotencyKey!==intent.idempotencyKey||(stopIntent?.jobDigest&&stopIntent.jobDigest===intent.jobDigest))return CLAIM_PARKED;
      Object.assign(cfg,policy);
      const policyBlocked=paused||!cfg.enabled,cleanupPending=sandboxAdmissionPending();
      if(signal?.aborted||policyBlocked||cleanupPending||!report?.available||!LIMITS.every(key=>report.enforced_limits?.includes(key))){
        intent=stageClaim({...intent,state:'created-unsent'});await save({...counters,claimPending:intent});active(signal);
        forgetAdmission();backend.invalidateLendingCapabilities?.();
        const found=await observeAvailable({cached:true,discoveryReport:report}).catch(()=>null);
        policyEvent(found?.reason??(policyBlocked?'paused':cleanupPending?'cleanup_pending':report?.reason??'sandbox_not_ready'));return CLAIM_PARKED;
      }
    }
    // No application await separates the fresh check above from invocation below.
    const pending=observePoll(()=>request.jobDigest
      ? client.claimJob(request.jobDigest,request.advertisement,{signal,leaseSeconds:request.leaseSeconds,idempotencyKey:request.idempotencyKey})
      : client.claimNext(request.advertisement,{signal,leaseSeconds:request.leaseSeconds,waitSeconds:request.waitSeconds,idempotencyKey:request.idempotencyKey,...(request.exclude?{exclude:request.exclude}:{})}));
    sentClaims.set(intent.idempotencyKey,fingerprint);
    const outcome=await pending.then(value=>{
      intent=stageClaim({...intent,state:'confirmed',claimResult:structuredClone(value)});sentClaims.delete(intent.idempotencyKey);
      return {value};
    },cause=>{
      let state=intent.state;
      if(cause.code==='lease_expired'&&observedExecutionTime(cause.committedAttempt)===null&&intent.jobDigest)state='expired-unstarted';
      else if(cause.claimRejected||((cause.outcome==='not_applied'||cause.status>=400)&&!retryPending(cause)))state='rejected';
      if(state!=='sent-uncertain'){
        const claimError={code:cause.code??'claim_failed'};
        for(const key of ['status','retryable','claimRejected','committedAttempt','retryAfterSeconds','outcome','responseReceived'])
          if(cause[key]!==undefined)claimError[key]=structuredClone(cause[key]);
        intent=stageClaim({...intent,state,claimError});sentClaims.delete(intent.idempotencyKey);
      }
      else if(!retryPending(cause))sentClaims.delete(intent.idempotencyKey);
      return {cause};
    });
    if(intent.state!=='sent-uncertain')await save({...counters,claimPending:intent});
    if(outcome.cause)throw Object.assign(outcome.cause,{claimRejected:intent.state==='rejected'||outcome.cause.claimRejected});
    return outcome.value;
  }
  // The last availability this account's loop observed (its answer: usable, or the reason) and when it started. admits() is sync, so
  // it reads this record. It is unknown until observed, after a known change, and after AVAILABILITY_MAX_AGE_MS. A result
  // commits only if no other evaluation or invalidation started after it, so an older answer never overwrites a newer one.
  let admission=null, admissionGeneration=0;
  const forgetAdmission=()=>{admissionGeneration++;admission=null;};
  async function observeAvailable({cached=false,discoveryReport=null}={}) {
    const generation=++admissionGeneration, startedAt=now();
    let found;
    try {found=await availability(null,{cached,discoveryReport,observing:true});}
    catch(e){if(generation===admissionGeneration)admission=null;throw e;}
    if(generation===admissionGeneration)admission={reason:found.adapter?null:found.reason,at:startedAt};
    return found;
  }
  async function lendingConditions(job,usage=counters,facts={}) {
    const external=await cfg.observeLending?.(job)??{};
    const waits=[...(external.waits??[])];
    const wait=(reason,nextEvaluationAtMs=now()+120000)=>waits.push({reason,nextEvaluationAtMs});
    let runtime=external.runtime??{canStart:true};
    if(facts.reason){
      const disk=facts.report?.reason==='host_disk_low'||facts.report?.preflight?.checks?.some(c=>c.ok===false&&c.unknown!==true&&(c.reason??c.cause)==='host_disk_low');
      const confirmed=disk||['docker_signed_out','guard_runtime_unavailable'].includes(facts.report?.reason)||facts.report?.preflight?.checks?.some(c=>c.ok===false&&c.unknown!==true&&['host_disk_low','sbx_missing','sandbox_missing'].includes(c.reason??c.cause));
      if(confirmed)runtime={...runtime,canStart:false,...(disk?{nextAction:LOW_DISK_ACTION,detail:LOW_DISK_DETAIL}:{})};else wait(facts.ownerOnly?'cannot_run_here':facts.reason);
    }
    const nextDay=()=>{let at=Math.floor(now()/60000)*60000+60000;while(lenderDayKey(at,cfg.timeZone)===dayKey())at+=60000;return at;};

    // Existing work and uncertain claim recovery keep their ownership; only new work waits.
    if(!current&&sandboxAdmissionPending())wait('cleanup_pending');
    // A blocker (Docker signed out, isolation failure, the host) holds new claims but never changes the intent: lending stays on.

    // Outside lending hours nothing new is offered; a job already running is never cut short by the window.
    if(cfg.schedule){const hours=lendingHours(cfg.schedule,now(),cfg.timeZone);if(!hours.inside)wait('outside_hours',hours.until);}
    if(usage.pending)wait('cleanup_pending');
    // Stopped compute's file cleanup is background debt, not an execution slot.
    const dailyJobsReached=cfg.dailyJobs!==null&&usage.jobs>=cfg.dailyJobs;
    const dailyMinutesReached=cfg.dailyMinutes!==null&&(
      usage.milliseconds>=cfg.dailyMinutes*60000||
      (!job&&usage.milliseconds+1000>cfg.dailyMinutes*60000)||
      (job&&usage.milliseconds+job.requirements.limits.wall_seconds*1000>cfg.dailyMinutes*60000));
    if((!job||charged(job))&&(dailyJobsReached||dailyMinutesReached))
      wait('daily_limit',nextDay());
    if(job&&charged(job)) {
      const cap=cfg.requesterLimits.find(row=>row.circle===job.circle&&row.keyId===job.author);
      const used=usage.requesters?.[requesterCounterKey(job.circle,job.author)]??{jobs:0,milliseconds:0};
      if(cap&&((cap.dailyJobs!==null&&cap.dailyJobs!==undefined&&used.jobs>=cap.dailyJobs)||
         (cap.dailyMinutes!==null&&cap.dailyMinutes!==undefined&&
          used.milliseconds+job.requirements.limits.wall_seconds*1000>cap.dailyMinutes*60000)))wait('requester_limit',nextDay());
    }
    if(job&&cfg.maxWallSeconds!==null&&job.requirements.limits.wall_seconds>cfg.maxWallSeconds)wait('cannot_run_here');
    if(job&&Date.parse(job.expires_at)<=now())wait('job_expired');
    if(!job&&current)wait('approval_pending',Date.parse(current?.job?.payload?.expires_at));
    if(cfg.mode==='ask'&&typeof approve!=='function')wait('approval_pending');
    if(!offerReader&&cfg.mode==='auto'&&cfg.idleOnly&&!(await ownerAbsentFor(null)))wait('owner_active');
    return {enabledNow:cfg.enabled&&!paused&&external.enabledNow!==false,runtime,waits};
  }
  // The engine absence gate also passes when idle-only is off, or for a job the owner allowed while present.
  async function ownerAbsentFor(jobDigest) {
    if(!cfg.idleOnly)return true;
    if(typeof cfg.userActive==='function'&&await cfg.userActive()===false)return true;
    return false;
  }
  async function gate(job,signal,jobDigest=null,holdContext={}) {
    Object.assign(cfg,policy);
    validateRequesterLimits(cfg.requesterLimits);
    active(signal);await budget();
    const found=await availability(job,{cached:true});
    return found.decision.kind==='lend'?null:found.reason;
  }

  async function quotaGate(adapter,automatic=cfg.mode==='auto',jobDigest=null,job=null,selectedRun=null,offerDeadline=null) {
    // Account jobs have a mandatory account-scoped policy/ledger gate in
    // prepareLend. The owner's legacy provider meter is not their allowance.
    if(job?.runRequest!==undefined&&accountExecution)return null;
    return job?(checkNewJob(job).code??null):null;
  }
  const policyEvent=reason=>emit(reason==='host_refused'?'failed':reason==='daily_limit'?'limit-reached':reason==='quota_reserve'?'reserve':['sandbox_not_ready','cleanup_pending'].includes(reason)?'waiting_for_sandbox':'paused',{reason,
    ...(reason==='cleanup_pending'?{label:CLEANUP_WAIT_LABEL}:{}),
    ...(reason==='quota_unknown'?{label:"We can't measure your remaining allowance. Automatic lending is unavailable."}:{}),
    ...(reason==='host_refused'?{label:"The circle's host refused access. Check your circle membership and host address."}:{}),
    ...(reason==='circle_unreachable'?{label:"Lending is waiting for the circle's host to reconnect."}:{}),
    ...(reason==='update_required'?{label:'Update Faravan to keep lending.'}:{})});
  async function decline(attempt,reason,claim=current,retryAtMs=null) {
    const original=reason;
    reason=giveBackCode(original);
    let nextEvaluationAtMs=retryAtMs;
    if(!Number.isSafeInteger(nextEvaluationAtMs)||nextEvaluationAtMs<=now()){
      try{const found=await availability(claim?.job?.payload??null,{cached:true});
        if((found.decision.code??found.decision.reason)===reason)nextEvaluationAtMs=found.decision.nextEvaluationAtMs;
      }catch{}
    }
    if(!Number.isSafeInteger(nextEvaluationAtMs)||nextEvaluationAtMs<=now())nextEvaluationAtMs=now()+120000;
    forgetAdmission();backend.invalidateLendingCapabilities?.();
    if(stopIntent?.attemptId===attempt.attempt_id)throw error('stopped_by_lender');
    // A decline intent is only ever written for a run whose start was never requested. recoverDecline clears such an intent
    // on a fenced view without local removal proof, which is safe only because the run never began.
    if(counters.pending?.attemptId===attempt.attempt_id&&counters.pending.executionStartRequested===true)throw error('decline_after_launch');
    const declined=(counters.declined??[]).filter(entry=>entry.expiresAt>now()&&entry.jobDigest!==attempt.job_digest);
    
    let startFailures=counters.startFailures;
    if(claim) {
      const jobExpiry=Date.parse(claim.job.payload.expires_at);
      claim.declineExpiresAt=Math.min(jobExpiry,nextEvaluationAtMs);
      // cleanup:true marks a cleanup give-back made while cleanup ran (see excluded).
      claim.declineEpoch={boot,epoch:readinessEpoch,...(reason==='cleanup_pending'&&sandboxAdmissionPending()?{cleanup:true}:{})};
      claim.declineReason=reason;
      if(reason==='start_failed') {
        // Each start failure of a job counts and doubles the wait, up to a cap. The wait is never for the job's life: only the
        // coordinator ends a job, and an older coordinator never does, so the lender keeps retrying until the job is terminal.
        const failures=(startFailures??[]).filter(entry=>entry.expiresAt>now());
        const count=(failures.find(entry=>entry.jobDigest===attempt.job_digest)?.count??0)+1;
        startFailures=[...failures.filter(entry=>entry.jobDigest!==attempt.job_digest),{jobDigest:attempt.job_digest,count,expiresAt:jobExpiry}].slice(-MAX_DECLINED);
        claim.declineExpiresAt=Math.min(jobExpiry,now()+Math.min(START_RETRY_BASE_MS*2**Math.min(count-1,10),START_RETRY_MAX_MS));
        claim.declineEpoch={boot,epoch:readinessEpoch};
      }
      if(declined.length<MAX_DECLINED)declined.push({jobDigest:attempt.job_digest,expiresAt:claim.declineExpiresAt,exclusionVersion:1,reason,...claim.declineEpoch});
    }
    declineUntilMono=0;
    await save({...counters,declined,declineUntil:0,...(startFailures?{startFailures}:{}),
      ...(reason==='requester_limit'&&claim?{lastRequesterLimit:{circle:claim.job.payload.circle,
        keyId:claim.job.payload.author,day:dayKey(),at:iso(now())}}:{}),
      declinePending:{attempt:structuredClone(attempt),reason:canonicalize({code:reason,...(reason==='start_failed'?{}:{until:claim?.declineExpiresAt??nextEvaluationAtMs})}),idempotencyKey:randomUUID()}});
    await contribution(original==='approval_timeout'?'timedOut':'skipped',claim);
    await recoverDecline();
    emit(reason==='start_failed'?'failed':reason==='daily_limit'?'limit-reached':reason==='quota_reserve'?'reserve':'declined',{reason,until:reason==='start_failed'?null:claim?.declineExpiresAt??nextEvaluationAtMs,
      ...(reason==='requester_limit'?{label:'A job was skipped because this device reached its daily lending limit.'}:{})});
  }
  // Recovery must yield even when transport never answers. A timeout says nothing
  // about remote application: replay the same durable body and key on the next pass.
  async function recoveryRequest(signal,send,timeoutMs=30000) {
    active(signal);
    const timeout=new AbortController(),bounded=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
    const timer=schedule(()=>timeout.abort(Object.assign(error('network_error'),{retryable:true,outcome:'unknown'})),timeoutMs);
    let stop;
    const aborted=new Promise((_,reject)=>{
      stop=()=>reject(bounded.reason);
      bounded.addEventListener('abort',stop,{once:true});
      if(bounded.aborted)stop();
    });
    try {
      return await Promise.race([Promise.resolve().then(()=>{active(bounded);return send(bounded);}),aborted]);
    } finally {
      unschedule(timer);bounded.removeEventListener('abort',stop);
    }
  }
  const releasedApproval=saved=>({...saved,
    lastDeclineOutcome:{...saved.declinePending,code:'released',at:iso(now())},
    jobConsents:(saved.jobConsents??[]).filter(e=>e.expiresAt>now()).map(e=>saved.declinePending?.stoppedByLender&&e.jobDigest===saved.declinePending?.attempt.job_digest?{...e,revoked:true}:e),
    hiddenOffers:(saved.hiddenOffers??[]).filter(e=>e.permanent||e.jobDigest!==saved.declinePending?.attempt.job_digest),
    acceptedClaim:saved.acceptedClaim?.claim?.job_digest===saved.declinePending?.attempt.job_digest?null:saved.acceptedClaim,declinePending:null});
  async function recoverDecline(signal) {
    const intent=counters.declinePending;
    if(!intent)return false;
    if(intent.stoppedByLender)await restoreStopRevocation(intent);
    try {
      await recoveryRequest(signal,signal=>client.release(intent.attempt,intent.reason,{signal,idempotencyKey:intent.idempotencyKey}));
      await save(releasedApproval,{stoppedReleaseAck:intent.stoppedByLender===true});
      pendingHiddenOffers.delete(intent.attempt.job_digest);
      if(intent.stoppedByLender){stopIntent=null;emitStopCompletion(intent.attempt);}
    }catch(e){
      if(!signal?.aborted&&!retryPending(e)&&stopReportFinal.has(e.code)) {
        // This journal can only describe work whose start was never requested.
        await save(saved=>({...saved,declinePending:null,lastDeclineOutcome:{...intent,code:e.code,at:iso(now())}}),
          {stoppedReleaseAck:intent.stoppedByLender===true});
        if(intent.stoppedByLender){stopIntent=null;emitStopCompletion(intent.attempt);}
        return true;
      }
      if(intent.rejectedClaim&&!signal?.aborted&&!retryPending(e)) {
        // This claim was never executed locally. A definitive cleanup rejection
        // cannot justify replaying the committed claim key; the server lease still fences it.
        await save({...counters,declinePending:null,lastClaimOutcome:{...counters.lastClaimOutcome,releaseCode:e.code??'release_rejected'}});
        return true;
      }
      // A rejected/replayed release may already be fenced. Reconcile only from
      // a fresh verified job view; an error code alone proves no terminal state.
      let fenced=false;
      try {
        const view=await recoveryRequest(signal,signal=>client.getJob(intent.attempt.job_digest,{signal}));
        const attempt=view.current_attempt;
        fenced=view.job_digest===intent.attempt.job_digest&&(
          ['result-accepted','cancelled','expired','failed'].includes(view.state)||
          attempt?.generation>intent.attempt.generation||
          (attempt?.attempt_id===intent.attempt.attempt_id&&
           attempt.generation===intent.attempt.generation&&
           ['completed','released','failed','expired','cancelled'].includes(attempt.state)));
      }catch{} // Preserve unknown/network outcomes and the exact durable intent.
      if(fenced) {
        await save(releasedApproval,{stoppedReleaseAck:intent.stoppedByLender===true});
        pendingHiddenOffers.delete(intent.attempt.job_digest);
        if(intent.stoppedByLender){stopIntent=null;emitStopCompletion(intent.attempt);}
        return true;
      }
      // Keep the exact release intent across an unknown transport outcome.
      emit('declined',{reason:e.code??'release_unknown'});
      await idle(signal,DECLINE_BACKOFF_MS);
    }
    return true;
  }
  async function execute(claim,initial,outerSignal) {
    const job=claim.job.payload, attempt=claim.attempt;
    const valid=checkNewJob(job);if(!valid.ok)throw error(valid.code);
    current=claim;forgetAdmission();
    const controller=new AbortController(), signal=controller.signal;
    let runStarted=null,runContribution=Promise.resolve(),runEnded=null,sandboxPrepared=false,agentLaunched=false,
      prepareUnverified=false,sandboxRemoved=false,lastMeter=null;
    let timer, deadlineTimer, wallTimer, providerLimitReturnTimer, wallEndsAt=0, preparationTimer, renewing=Promise.resolve(), ceased=false, executed=false, jobReturned=false,
      progress=null, transcriptPublisher=null, settled=false, finishing=false, outputHeld=false, started=0, startRequested=false, entrypointStarted=false;
    let leaseExpiry=Date.parse(attempt.lease_expires_at), cleanup=null, reserved=0, runningHarness=null, executionHandle=null, ownerDuringRun=false, reclaimTimer, ownerPresenceTimer, ownerReturnTimer;
    let stoppedReportOwned=true, agentStartDenied=false, launchCallbackRejected=false, admissionPending=false;
    let preparedScratchRecovery=null, preparedScratchDurable=true, retryPreparedScratch=null, unverifiedPreparedIdentity=null;
    const reportStopped=async()=>{
      // Cleanup may clear the execution journal only after this obligation has
      // a durable owner. A failed save must leave the original journal intact.
      stoppedReportOwned=false;
      const intent=counters.stoppedPending??{attempt:structuredClone(attempt),stoppedAt:iso(now()),idempotencyKey:randomUUID()};
      await save({...counters,stoppedPending:intent,
        ...(counters.pending?.attemptId===attempt.attempt_id?{pending:{...counters.pending,
          cessationVerified:{sbx_home:counters.pending?.sbx_home,attemptId:attempt.attempt_id,jobDigest:attempt.job_digest,generation:attempt.generation}}}:{})});
      stoppedReportOwned=true;
      await client.stopped(attempt,{stoppedAt:intent.stoppedAt,idempotencyKey:intent.idempotencyKey});
      await save({...counters,stoppedPending:null});
    };

    const stop=(why)=>{if(!signal.aborted){emit('stopping',{reason:why});controller.abort(error(why));}};
    pausePreparation=()=>{if(agentLaunched)return false;stop('paused');return true;};
    let stopRequested=false, stopPersistence=Promise.resolve(), heldStop=null;
    const stopForAttempt=async()=>{
      if(stopRequested)return true;
      if(settled)return stopIntent?.attemptId===attempt.attempt_id;
      // A normal result may be settling. An abort from the durable owner-stop event still needs its local restart journal.
      // Once the attempt holds finished output, a Stop must not end the job: delivering that output is all that is left.
      // The agent has already finished in that window, but its provider work and sandbox may still exist until cleanup is proven.
      // So a Stop still asks the backend to stop, without aborting the output save, upload or cleanup.
      // Lease renewal and sandbox cleanup do not depend on this flag, so they continue as before.
      if(finishing&&!signal.aborted)return false;
      if(outputHeld&&!signal.aborted){
        const answer=executionHandle&&typeof backend.requestStop==='function'?await backend.requestStop(executionHandle,'owner').catch(()=>null):null;
        if(!answer?.delivered&&!heldStop) {
          // Unproven delivery: keep the same durable Stop request the normal path keeps, and retry the stop once the output is saved.
          // The save queues behind the held output save, so it must not be awaited here.
          const key=counters.pending?.attemptId===attempt.attempt_id&&counters.pending.stopRequestKey||randomUUID();
          heldStop=save(saved=>saved.pending?.attemptId===attempt.attempt_id?
            {...saved,pending:{...saved.pending,stopRequestKey:key,gracefulStopReason:'owner'}}:saved).then(()=>true,()=>false);
          if(entrypointStarted)await publishStopRequest(attempt,key,signal);
        }
        return false;
      }
      stopRequested=true;stoppingNow=true;
      emit('stopping',{reason:'stopped_by_lender'});
      const stopRequestKey=counters.pending?.attemptId===attempt.attempt_id&&counters.pending.stopRequestKey||randomUUID();
      let gracefulDelivered=false;
      try {
        if(counters.pending?.attemptId===attempt.attempt_id)
          await save({...counters,pending:{...counters.pending,stopRequestKey}}).catch(()=>{});
        if(entrypointStarted)await publishStopRequest(attempt,stopRequestKey,signal.aborted?undefined:signal);
        if(executionHandle&&cfg.lendingRuntime&&QUOTA_PROVIDERS[runningHarness]&&typeof backend.requestStop==='function'){
          try {await save({...counters,pending:{...counters.pending,gracefulStopReason:'owner'}});}
          catch(cause) {
            // A rejected journal write delivered no graceful Stop. Keep the
            // in-memory revocation and let finally abort the actual backend.
            // The caller still receives the persistence failure, not success.
            throw cause;
          }
          const answer=await backend.requestStop(executionHandle,'owner').catch(()=>null);
          if(answer?.delivered){gracefulDelivered=true;return true;}
        }
        stopIntent={attempt:structuredClone(attempt),attemptId:attempt.attempt_id,jobDigest:claim.job_digest,stopOfferExpiresAt:Date.parse(job.expires_at),stopReason:'stopped_by_lender',
          stopRequestKey,stopReleaseKey:randomUUID(),stopReportKey:randomUUID()};
        stopPersistence=save(saved=>({...saved,claimedPending:null,...(saved.pending?{pending:{...saved.pending,...stopIntent}}:
          {declinePending:{attempt:structuredClone(attempt),reason:canonicalize({code:'stopped_by_lender'}),idempotencyKey:stopIntent.stopReleaseKey,
            stoppedByLender:true,stopOfferExpiresAt:stopIntent.stopOfferExpiresAt}})}));
        await stopPersistence;
      } finally {if(!gracefulDelivered)stop('stopped_by_lender');}
      return true;
    };
    stopCurrent=stopForAttempt;
    const cancelOwnerReturn=()=>{unschedule(ownerReturnTimer);ownerReturnTimer=null;};
    const stopOnReturn=()=>cfg.idleOnly&&policy.lendingPolicy?.stopOnReturn===true;
    const observeOwner=active=>{
      if(signal.aborted||settled)return;
      ownerDuringRun=active===true;
      if(!ownerDuringRun||!stopOnReturn()){cancelOwnerReturn();return;}
      if(ownerReturnTimer!=null)return;
      ownerReturnTimer=schedule(async()=>{
        ownerReturnTimer=null;
        if(signal.aborted||settled||outputHeld||!stopOnReturn())return;
        try{
          if(await cfg.userActive?.()===true)await stopForAttempt();
        }catch(cause){diagnose(claim.job_digest,cause?.code??'owner_stop_failed','running');}
      },120000);
    };
    const sampleOwner=async()=>{
      if(signal.aborted||settled||outputHeld)return;
      try{observeOwner(stopOnReturn()?await cfg.userActive?.():false);}catch{observeOwner(null);}
      if(!signal.aborted&&!settled&&!outputHeld&&stopOnReturn())ownerPresenceTimer=schedule(sampleOwner,5000);
    };


    const external=()=>stop('cancelled');
    outerSignal?.addEventListener('abort',external,{once:true});
    if(outerSignal?.aborted)external();
    const armDeadline=()=>{
      unschedule(deadlineTimer);
      deadlineTimer=schedule(()=>stop('lease_expired'),Math.max(0,Math.min(leaseExpiry,Date.parse(job.expires_at))-now()));
    };
    // The wall_seconds run clock starts at the protected agent handoff, after the coordinator accepted the start.
    const beginRunClock=()=>{
      wallEndsAt=monotonic()+reserved;stopsByMs=now()+reserved;
      unschedule(wallTimer);wallTimer=schedule(()=>stop('wall_timeout'),reserved);
    };
    const renew=async()=>{
      if(signal.aborted||settled)return;
      try {
        const renewed=await client.renew(attempt,{leaseSeconds:cfg.leaseSeconds,signal});
        if(renewed.state!=='active'||renewed.generation!==attempt.generation){stop(renewed.state==='cancelled'?'cancelled':'stale_attempt');return;}
        leaseExpiry=Date.parse(renewed.lease_expires_at);
        if(leaseExpiry<=now()){stop('lease_expired');return;}
        armDeadline();
      }catch(e){stop(e.code??'lease_uncertain');}
      if(!signal.aborted&&!settled&&!finishing)timer=schedule(()=>{renewing=renew();},cfg.renewMs);
    };
    armDeadline();timer=schedule(()=>{renewing=renew();},cfg.renewMs);
    try {
      const selectedRun=matchingRun(claim.claimAdvertisement??initial.advertisement,job);
      if(job.budget_v1?.effort!==undefined&&(!selectedRun||effortAbove(job.budget_v1.effort,cfg.lendingRuntime?.effortMax?.()??'high'))){await decline(attempt,'requirements_unsupported');return;}
      // A signed run request runs only on an account the lender advertised for it; no match is a refusal, never a different account.
      let selection=null;
      if(job.runRequest!==undefined){
        if(!accountExecution){await decline(attempt,'host_too_old');return;}
        // This lender runs one provider adapter, named by its harness id. Only that provider's advertised accounts can run the request.
        const mine=accountsForProviders((claim.claimAdvertisement??initial.advertisement).accounts,[initial.adapter.accountProviderId??initial.adapter.spec.harness_id]);
        const resolved=resolveSelection({runRequest:job.runRequest,accounts:mine});
        if(!resolved.ok){await decline(attempt,'requirements_unsupported');return;}
        selection=resolved.value;
        if(selection.effortId!==null&&effortAbove(selection.effortId,cfg.lendingRuntime?.effortMax?.()??'high')){await decline(attempt,'requirements_unsupported');return;}
        if(!attempt.selection||canonicalize(selection)!==canonicalize(attempt.selection)){await decline(attempt,'requirements_unsupported');return;}
      }
      let why=await gate(job,signal,claim.job_digest)??await quotaGate(initial.adapter,claim.accepted?claim.automatic:cfg.mode==='auto',claim.job_digest,job,selectedRun);
      if(why){if(why==='lending_off'&&claim.accepted){stop('paused');active(signal);}await decline(attempt,why);return;}
      let chosen=initial;
      if(claim.accepted&&chosen.adapter.spec.harness_id!==claim.acceptedHarness){await decline(attempt,'readiness_changed');return;}
      if(job.budget_v1?.effort===undefined&&chosen.adapter.run?.model&&job.requirements.model&&
         !job.requirements.model.any_of.includes(chosen.adapter.run.model)){
        await decline(attempt,'model_unavailable');return;
      }
      if(!canSatisfy(job.requirements,chosen.advertisement,{job}).ok){await decline(attempt,'requirements_unsupported');return;}
      if((job.source.kind==='git'&&chosen.report.pinned_git!==true)||
         (job.source.kind==='archive'&&job.source.artifact?.media_type!=='application/gzip')||
         !['git','archive','none'].includes(job.source.kind)){
        await decline(attempt,'policy_unenforceable');return;
      }
      const prompt=await client.fetchArtifact(job.prompt,{signal,job:claim.job_digest});
      const title=[...cleanTitle(requestLine(Buffer.from(prompt).toString('utf8')))].slice(0,120).join('');
      // Readiness is rechecked below; a different selected harness must decline this attempt.
      const displayFacts={...(title?{title}:{}),agent:chosen.adapter.spec.harness_id};
      active(signal);
      // Only the older-host fallback claims before asking. Source is not fetched until the lender says yes, so a request that is
      // declined or times out never puts the sender's code on this computer. The card has no file count for that reason.
      let sourceFiles=null;
      const scopedAutomatic=cfg.mode==='auto'&&matchingRule(cfg.standingRules,job,chosen.adapter.spec.harness_id,{now:now(),timeZone:cfg.timeZone,usage:ruleUsage});
      if(!claim.accepted&&!scopedAutomatic) {
        if(typeof approve!=='function'){await decline(attempt,'approval_unavailable');return;}
        await contribution('reviewed');
        emit('awaiting-approval');
        const approvalTimeout=new AbortController();
        const timeoutSignal=AbortSignal.any([signal,approvalTimeout.signal]);
        // One deadline for the lender and the review card: the card closes when this wait ends.
        const approvalExpiresAt=now()+cfg.legacyHoldMs;
        let accepted, approvalExpired=false;
        try {
          const jobExpiresAt=Date.parse(job.expires_at);
          accepted=await holdsConsent(claim.job_digest,jobExpiresAt)?true:await Promise.race([
            Promise.resolve().then(()=>approve({jobDigest:claim.job_digest,job:structuredClone(job),
              prompt:Buffer.from(prompt).toString('utf8'),harness:chosen.adapter.spec.harness_id,
              startsNow:true,credentialInGuest:chosen.adapter.spec.credential_in_guest===true,sourceFiles,
              expiresAt:approvalExpiresAt,signal:timeoutSignal})),
            wait(cfg.legacyHoldMs,timeoutSignal).then(()=>{approvalExpired=true;return false;}),
          ]);
        }finally{approvalTimeout.abort();}
        active(signal);
        if(accepted===true)await rememberConsent(claim.job_digest,Date.parse(job.expires_at));
        else if(accepted===false||accepted?.declined===true){
          await revokeConsent(claim.job_digest);
          if(!approvalExpired)await hideWaitingOffer(claim.job_digest,Date.parse(job.expires_at));
        }
        why=await gate(job,signal);
        if(why){await decline(attempt,why);return;}
        if(accepted!==true){await decline(attempt,approvalExpired||accepted?.timedOut===true?'approval_timeout':accepted?.declined===true?'approval_denied':'approval_skipped');return;}
        await contribution('accepted',claim,displayFacts);
      }
      if(claim.accepted){
        await rememberConsent(claim.job_digest,Date.parse(job.expires_at));
        if(!claim.automatic)await contribution('reviewed');
      }
      if(!claim.accepted&&scopedAutomatic) {
        // Older-host fallback: the claim came first, so the standing rule's grant is recorded before any source is fetched.
        const entry={id:attempt.attempt_id,jobDigest:claim.job_digest,circle:job.circle,requester:job.author,at:now(),rule:structuredClone(scopedAutomatic)};
        await onDecision(entry);
        const fenced=await afterAudit(job,chosen,entry.rule,signal);
        if(fenced){await onDecisionNotApplied({...entry,reason:fenced}).catch(()=>{});active(signal);await decline(attempt,fenced==='rule_changed'?'readiness_changed':fenced);return;}
        if(!counters.ruleUsage?.some(e=>e.attemptId===attempt.attempt_id))await save({...counters,ruleUsage:[...(counters.ruleUsage??[]).filter(e=>e.at>now()-7*86400000),{id:scopedAutomatic.id,attemptId:attempt.attempt_id,at:now(),ms:job.requirements.limits.wall_seconds*1000}]});
      }
      if(scopedAutomatic||claim.accepted)await contribution('accepted',claim,displayFacts);
      emit('preparing',{label:sandboxAdmissionPending()?CLEANUP_WAIT_LABEL:'Preparing the job…'});
      preparationTimer=schedule(()=>stop(admissionPending&&sandboxAdmissionPending()?'cleanup_pending':'preparation_timeout'),cfg.preparationTimeoutMs);
      signal.addEventListener('abort',()=>unschedule(preparationTimer),{once:true});
      // Re-read readiness and policy after user interaction; membership is checked by renew.
      chosen=await available(job);
      why=await gate(job,signal,claim.job_digest)??(chosen?await quotaGate(chosen.adapter,claim.accepted?claim.automatic:cfg.mode==='auto',claim.job_digest,job,selectedRun):null);
      if(job.budget_v1?.effort===undefined&&chosen?.adapter.run?.model&&job.requirements.model&&
         !job.requirements.model.any_of.includes(chosen.adapter.run.model)){
        await decline(attempt,'model_unavailable');return;
      }
      if(why||!chosen||!canSatisfy(job.requirements,chosen.advertisement,{job}).ok ||
         (selectedRun&&!chosen.advertisement.model_efforts?.some(p=>p.harness===chosen.adapter.spec.harness_id&&p.model===selectedRun.model&&p.effort===selectedRun.effort)) ||
         chosen.adapter.spec.harness_id!==initial.adapter.spec.harness_id){await decline(attempt,why??'readiness_changed');return;}
      if(job.source.kind==='git'&&chosen.report.pinned_git!==true){await decline(attempt,'policy_unenforceable');return;}
      await client.renew(attempt,{leaseSeconds:cfg.leaseSeconds,signal}).then(a=>{
        if(a.state!=='active'||a.generation!==attempt.generation||a.attempt_id!==attempt.attempt_id)throw error('stale_attempt');
        leaseExpiry=Date.parse(a.lease_expires_at);if(leaseExpiry<=now())throw error('lease_expired');armDeadline();
      });
      active(signal);
      const lim=job.requirements.limits;
      // Disk is never enforced on the host: a job that requires it is refused at admission. The host
      // disk watch stops a lent job when free space runs low (lib/host-disk.mjs); it is not a limit.
      const requiredLimits=limitRequirements(job.requirements).required;
      if(['memory_bytes','disk_bytes'].some(k=>requiredLimits.includes(k)&&lim[k]%1048576))
        {await decline(attempt,'limits_unenforceable');return;}
      // The selection is the run: its model and effort are what the agent is started with, never the adapter's own default.
      const bound=selection;
      const run=bound?{model:bound.modelId,effort:bound.effortId}:selectedRun??{model:chosen.adapter.run?.model??
        job.requirements.model?.any_of.find(model=>chosen.advertisement.models.includes(model))??null,
        effort:job.budget_v1?.effort??chosen.adapter.run?.effort??null};
      const words=RUN_FLAGS[chosen.adapter.spec.harness_id]?.(run)??[];
      const spec=buildValidatedJobSpec({taskDigest:claim.job_digest.slice(7),harness:chosen.adapter.spec,executionScope:await ownJob(job)?'owner':'borrowed',
        entrypointWithPrompt:[chosen.adapter.spec.entrypoint,...words.map(quote),quote(Buffer.from(prompt).toString('utf8'))].join(' '),
        network:job.requirements.egress,requiredLimits:requiredLimits.map(k=>EVIDENCE_LIMIT[k]),
        ...(job.verify ? {verify:job.verify} : {}),
        resources:{cpu:lim.cpu,memory_mib:Math.floor(lim.memory_bytes/1048576),storage_mib:Math.floor(lim.disk_bytes/1048576),
          wall_seconds:lim.wall_seconds,output_bytes:lim.output_bytes,network_bytes:1,max_processes:1}});
      if(bound)spec.job_id=claim.job_digest;
      // Admission can join a shared cleanup pass. Abort only this pre-start wait,
      // never that shared pass; a late result is observed but cannot launch work.
      active(signal);
      const pendingAdmission=backend.admitJob(spec,{accountBroker:selection!==null});
      admissionPending=true;
      if(sandboxAdmissionPending())emit('preparing',{label:CLEANUP_WAIT_LABEL});
      let abortAdmission,admission;
      const admissionStopped=new Promise((_,reject)=>{
        abortAdmission=()=>reject(signal.reason??error('cancelled'));
        signal.addEventListener('abort',abortAdmission,{once:true});
        if(signal.aborted)abortAdmission();
      });
      try {admission=await Promise.race([pendingAdmission,admissionStopped]);active(signal);}
      finally {admissionPending=false;signal.removeEventListener('abort',abortAdmission);}
      if(!admission.ok){await decline(attempt,admission.code??'policy_unenforceable');return;}
      // The runtime atomically reserved this job's allowance. A second free-allowance
      // check would count its own hold against it and refuse an admitted job.
      why=await gate(job,signal,claim.job_digest,{attemptId:attempt.attempt_id})??(await quotaGate(chosen.adapter,claim.accepted?claim.automatic:cfg.mode==='auto',claim.job_digest,job,selectedRun));
      if(why){await decline(attempt,why);return;}
      reserved=lim.wall_seconds*1000;
      const share=charged(job)?1:0;
      await save({...counters,jobs:counters.jobs+share,milliseconds:counters.milliseconds+share*reserved,
        requesters:share?requesterDelta(job.circle,job.author,1,reserved):counters.requesters,
        pending:{...backend.sandboxOwnership?.(),attemptId:attempt.attempt_id,attempt:structuredClone(attempt),jobId:spec.job_id,reservedMs:reserved,prepare_contract:'create-only',...(share?{}:{charged:false}),
          ...(counters.acceptedClaim?.intent.ruleId?{ruleGrant:{ruleId:counters.acceptedClaim.intent.ruleId,jobDigest:counters.acceptedClaim.intent.jobDigest,acceptedAt:counters.acceptedClaim.intent.acceptedAt}}:{}),
          resources:{cpu:lim.cpu,memoryBytes:lim.memory_bytes},requester:{circle:job.circle,keyId:job.author},executionStartRequested:false,startIdempotencyKey:randomUUID()}});

      Object.assign(cfg,policy);
      if(paused||!cfg.enabled){await decline(attempt,'paused');return;}
      active(signal);executed=true;runningHarness=chosen.adapter.spec.harness_id;current.agent=runningHarness;emit('preparing',{label:'Preparing with '+chosen.adapter.spec.harness_id+' · '+(job.requirements.model?.any_of.join(' / ')??'Model not reported')});
      // Preparation has its own bounds (preparationTimer, the lease, the sandbox's preparation cap) and the wall_seconds run
      // clock starts at the agent handoff (beginRunClock). A signed broker-account run takes the same split: its wrapper
      // (account-execution.mjs) hands this lender's lease clock to its own prepare, re-proves the exact lease before start,
      // and the backend's durable deadline covers both phases. A backend call that was not given the lease clock keeps its own
      // combined wall from prepare entry, which is never longer than this one.
      stopsByMs=now()+Math.min(reserved+cfg.preparationTimeoutMs,Math.max(0,Math.min(leaseExpiry,Date.parse(job.expires_at))-now()));
      let {knownValues,scanUnavailable}=await scanValues(bound,attempt.attempt_id);
      if(scanUnavailable){
        advisory(onDiagnostic,{at:iso(now()),job:claim.job_digest,ref:newErrorRef(),code:'transcript_scan_unavailable',phase:'prepare',
          message:'Private-value scanning was unavailable. Transcript text was withheld.'});
      }
      let workspaceOutput=workspaceTranscript('/workspace',{privateValues:knownValues,scanUnavailable});
      let streamedStdout='',stdoutLength=0;
      let transcriptBytes=0;
      const transcriptLimit=Math.min(lim.output_bytes,16*1024*1024);
      const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
      // Optional progress channel: coarse steps for the borrower. A client without it, or any send error, changes nothing.
      // P22: only when the host says it has the route; a host that predates it never receives a progress post.
      const host=await (typeof client.capabilities==='function'?client.capabilities({signal}).catch(()=>null):Promise.resolve(null));
      const hostHasProgress=host?host.capabilities.includes('progress_v1'):typeof client.capabilities!=='function';
      progress=typeof client.postProgress==='function'&&hostHasProgress?createProgressReporter({now,
        sleep:ms=>new Promise(resolve=>schedule(resolve,ms)),
        send:entry=>client.postProgress(attempt,{...entry,signal})}):null;
      // Stage events (P8b): whole seconds on the monotonic clock since this attempt began preparing.
      // Only phases that really run are reported; verification is optional.
      const preparationStarted=monotonic();
      const stage=name=>progress?.stage(name,Math.max(0,Math.floor((monotonic()-preparationStarted)/1000)));
      stage('preparing');
      const transcriptEvent=(stream,chunk)=>{
        if(!chunk)return;
        if(stream==='stdout')streamedStdout+=chunk;
        if(stream==='stdout')progress?.feed(chunk);
        transcriptPublisher?.append(chunk,stream);
        // Transcript is an observation, not a new lending status or authority.
        advisory(onEvent,{status:'transcript',jobDigest:claim.job_digest,chunk,stream});
      };
      let result;
      const recordScratchCleanup=async(receipt,handle)=>{
        if(receipt?.scratch_removed!==false)return;
        await save(saved=>({...saved,scratchPending:[...(saved.scratchPending??[]).filter(row=>row.attemptId!==attempt.attempt_id),
          {...saved.pending,scratchDir:handle?.scratch_dir??saved.pending?.scratchDir??null}]}));
      };
      // Preserve backend receivers (including private class state), intercepting
      // only the first entrypoint. Source extraction/cloning has already finished.
      let accountBackend=backend;
      if(bound) {
        try{accountBackend=await accountExecution.wrap({client,attempt,selection:bound,job,promptText:Buffer.from(prompt).toString('utf8'),spec,backend,signal});}
        catch(e){
          // A no-can-run answer that arrived after the claim (its account stopped lending between the
          // advertisement and the launch) declines like every earlier admission gate: the job reopens for
          // other lenders with its real reason. Execution faults keep their own failure path.
          if(e.admissionDecline!==true)throw e;
          await decline(attempt,e.waitReason??e.code,claim,e.retryAtMs);
          return;
        }
      }
      const executionBackend=new Proxy(accountBackend,{get(target,name){
        if(name==='prepare')return async(...args)=>{
          let handle;
          try {handle=await target.prepare(...args);}
          catch(e){
            await recordScratchCleanup(e?.cleanup_receipt??e?.cleanupReceipt);
            // A failed preparation proves no absence unless the backend's own receipt says the sandbox was removed.
            if((e?.cleanup_receipt??e?.cleanupReceipt)?.removed!==true)prepareUnverified=true;
            throw e;
          }
          // Own the returned handle before any journal wait. Until this wrapper
          // returns, runJob has neither the handle nor its ordinary abort listener.
          executionHandle=handle;sandboxPrepared=true;
          let cancellation=null;
          const cancelPrepared=()=>{
            cancellation??=Promise.resolve().then(()=>target.cancel(handle));
            // Observe listener-triggered rejection immediately; the owner below
            // still awaits the original promise before attempting removal.
            cancellation.catch(()=>{});
            return cancellation;
          };
          const abortPrepared=()=>{cancelPrepared();};
          signal.addEventListener('abort',abortPrepared,{once:true});
          if(signal.aborted)abortPrepared();
          const incarnation=createIdOf(handle);
          const identity={sandboxId:handle?.sandbox_id??null,scratchDir:handle?.scratch_dir??null,
            sbx_runtime:handle?.sbx_runtime??null,...(incarnation?{sandboxIncarnation:incarnation}:{})};
          const saveIdentity=()=>save(saved=>({...saved,pending:{...saved.pending,...identity}}));
          try {
            if(bound){
              const refreshed=await scanValues(bound,attempt.attempt_id);
              knownValues=[...new Set([...knownValues,...refreshed.knownValues])];
              scanUnavailable ||= refreshed.scanUnavailable;
            }
            workspaceOutput=workspaceTranscript(handle.scratch_dir,{privateValues:knownValues,scanUnavailable});
            if(host?.capabilities.includes('transcript_relay_v1')&&typeof client.postLiveTranscript==='function')
              transcriptPublisher=createTranscriptPublisher({privateValues:knownValues,scanUnavailable,now,schedule,unschedule,send:entry=>client.postLiveTranscript(attempt,{...entry,signal})});
            // Persist only the non-secret recovery identity, never credentials.
            await saveIdentity();
            active(signal);
            return handle;
          } catch(e) {
            // No executor/source/output work has begun: this is the safe
            // pre-output cleanup boundary. Cancellation alone proves no removal.
            try {await cancelPrepared();}
            catch { /* Cancellation failure does not revoke independent removal ownership. */ }
            try {cleanup=await target.destroy(handle);}
            catch {
              unverifiedPreparedIdentity=identity;
              try {await saveIdentity();} catch { /* Finalization still owns the unverified handle. */ }
            }
            try {
              // Retain actual proof independently of whether the primary error
              // accepts decoration (it may be frozen or nonextensible).
              if(cleanup?.removed===true)sandboxRemoved=true;
              try {e.cleanupReceipt=cleanup;} catch { /* Preserve the initiating error. */ }
              if(cleanup?.scratch_removed===false){
                // Scratch ownership is independent of removal and error decoration.
                // Retain only recovery fields, never the handle's private state.
                preparedScratchRecovery={...counters.pending,sandboxId:handle.sandbox_id,
                  scratchDir:handle.scratch_dir,sbx_runtime:handle.sbx_runtime??null};
                preparedScratchDurable=false;
                retryPreparedScratch=async()=>{
                  if(preparedScratchDurable)return;
                  await save(saved=>({...saved,scratchPending:[
                    ...(saved.scratchPending??[]).filter(row=>row.attemptId!==attempt.attempt_id),
                    preparedScratchRecovery]}));
                  preparedScratchDurable=true;
                };
                try {await retryPreparedScratch();} catch { /* Original pending still owns scratch. */ }
              }
            } catch { /* Keep the primary failure; finalization retries durable proof. */ }
            throw e;
          } finally {
            // On success runJob installs its listener and checks aborted again
            // before any work. On failure this owner has joined its cancel.
            signal.removeEventListener('abort',abortPrepared);
          }
        };
        if(name==='destroy')return async(...args)=>{const receipt=await target.destroy(...args);await recordScratchCleanup(receipt,args[0]);if(receipt?.removed===true)sandboxRemoved=true;return receipt;};
        if(name==='start')return async(handle,options)=>{
          if(handle._bookkeeping===true){
            active(signal);
            return target.start(handle,{...options,signal});
          }
          // Guest-side base/diff bookkeeping is not the agent: it must not mark execution as started.
          if(!entrypointStarted&&!isGitCandidateScript(handle._entrypoint)&&handle._sourcePreparation!==true) {
            active(signal);
            if(paused||policy.enabled!==true){stop('paused');active(signal);}
            try {
              await save(saved=>({...saved,pending:{...saved.pending,executionStartRequested:true}}));
              active(signal);startRequested=true;started=monotonic();
              const marked=await client.startAttempt(attempt,{signal,idempotencyKey:counters.pending.startIdempotencyKey});
              if(marked.state!=='active'||marked.attempt_id!==attempt.attempt_id||
                 marked.generation!==attempt.generation||!marked.execution_started_at)throw error('stale_attempt');
              active(signal);


              active(signal);entrypointStarted=true;unschedule(preparationTimer);beginRunClock();
            } catch(e) {
              // No backend dispatch is possible until this sequence completes.
              // Persist the denial even when start or its authority check fails.
              agentStartDenied=true;deniedStart=attempt.attempt_id;
              await save(saved=>({...saved,pending:{...saved.pending,agentStartDenied:true}}));
              throw e;
            }
          }

          let executionStartReported=false;
          const agentEntry=entrypointStarted&&!isGitCandidateScript(handle._entrypoint)&&handle._sourcePreparation!==true;
          const onLaunchDurable=async(evidence={})=>{
            try {
              const observedMs=Date.parse(evidence.at??'');
              const intent={attempt:structuredClone(attempt),observedAt:iso(Number.isFinite(observedMs)?observedMs:now()),idempotencyKey:randomUUID()};
              await save(saved=>({...saved,observationPending:[...(saved.observationPending??[]),intent]}),{observationWrite:true});
              const acknowledgments=await recoverObservation(signal);
              const observed=acknowledgments?.get(intent.idempotencyKey);
              active(signal);
              // The local lease includes successful renewals during observation persistence.
              if(leaseExpiry<=now())throw error('lease_expired');
              const pending=(counters.observationPending??[]).find(row=>row.idempotencyKey===intent.idempotencyKey);
              if(pending&&!observationUnsupported(pending))throw error('execution_observation_failed');
              // Recording history does not grant launch authority to a terminal attempt.
              if(!pending&&(observed?.state!=='active'||observed.compute_stopped===true)) {
                stop(observed?.state==='cancelled'?'cancelled':'stale_attempt');
                active(signal);
              }
            } catch(e) {
              // The backend writes the guest secret only after this callback resolves.
              // Any rejection here therefore proves that this agent never launched.
              agentStartDenied=true;launchCallbackRejected=true;deniedStart=attempt.attempt_id;
              await save(saved=>({...saved,pending:{...saved.pending,agentStartDenied:true}}));
              throw e;
            }
          };
          const onExecutionStarted=()=>{
            if(executionStartReported||!entrypointStarted||isGitCandidateScript(handle._entrypoint)||handle._sourcePreparation===true)return;
            executionStartReported=true;
            agentLaunched=true;
            if(stopOnReturn())ownerPresenceTimer=schedule(sampleOwner,5000);
            emit('running',{label:'Running with '+chosen.adapter.spec.harness_id});stage('agent');
            runStarted={at:now(),mono:monotonic()};
            runContribution=contribution('run',claim,{at:runStarted.at,...displayFacts});
          };
          return target.start(handle,{...options,onExecutionStarted,...(agentEntry?{onLaunchDurable}:{})});
        };
        const value=Reflect.get(target,name,target);
        return typeof value==='function'?value.bind(target):value;
      }});
      try {
        result=await runJob({preparationContext:Object.freeze({jobId:spec.job_id,attemptId:attempt.attempt_id,generation:attempt.generation}),accountKey:accountKey,jobSpec:spec,...(job.working_directory?{workingDirectory:job.working_directory}:{}),frameJob:{harnessId:chosen.adapter.spec.harness_id,prompt:Buffer.from(prompt).toString('utf8'),args:words,
            ...(job.result?{result:job.result.kind}:{})},
          onCollected:async result=>{
            unschedule(ownerPresenceTimer);cancelOwnerReturn();
            if(result.collected.reduce((bytes,file)=>bytes+file.bytes_content.byteLength,0)>lim.output_bytes)
              throw error('output_too_large');
            outputHeld=true;
            const persisted={...result,execution:{...result.execution,stdout:workspaceOutput.text(result.execution.stdout),
              ...(result.execution.workspace_path?{workspace_path:scanUnavailable?'/workspace':workspaceOutput.text(result.execution.workspace_path)}:{})},
              collected:result.collected.map(file=>({...file,bytes_content:Buffer.from(file.bytes_content).toString('base64')}))};
            // Keep the collected bytes while a transient disk failure prevents the
            // first durable copy. The executor must not clean up before this succeeds.
            for(;;) {
              try {
                await save({...counters,outputPending:{result:persisted,claim:structuredClone(claim),
                  chosen:{adapter:{spec:{harness_id:chosen.adapter.spec.harness_id},harnessVersion:chosen.adapter.harnessVersion},report:{backend_id:chosen.report.backend_id}},
                  prompt:Buffer.from(prompt).toString('base64'),run}});
                break;
              }catch(e) {
                if(!['EIO','ENOSPC','EDQUOT','EMFILE','ENFILE','EBUSY'].includes(e.code))throw e;
                emit('sending-result',{reason:'output_save_pending'});
                // This handoff owns collected bytes independently of execution
                // cancellation. The executor cancels compute and waits to delete.
                await wait(cfg.pollMs);
              }
            }
            // A Stop that arrived while the output was held and was not proven delivered: stop the provider work now.
            if(heldStop){
              await heldStop;
              if(executionHandle&&typeof backend.requestStop==='function')await backend.requestStop(executionHandle,'owner').catch(()=>null);
            }
          },
          backend:executionBackend,signal,onMeter:event=>{lastMeter=event;
          if(cfg.idleOnly&&typeof cfg.userActive==='function')Promise.resolve(cfg.userActive()).then(active=>{
            observeOwner(active);

          }).catch(()=>{});
        },now:()=>new Date(now()),durationNow:monotonic,wallRemainingMs:()=>Math.max(0,(wallEndsAt?wallEndsAt:monotonic()+Math.max(0,Math.min(leaseExpiry,Date.parse(job.expires_at))-now()))-monotonic()),onStage:stage,
          // A typed result returns faravan-output/ (or legacy faravan-output/) as a tree; code-change jobs keep the diff.
          // A filtered pinned snapshot has no original object database. Return
          // its tree rather than claiming a patch against an inaccessible base.
          ...(job.result?{outputDir:[OUTPUT_DIR]}:{gitDiff:job.source.kind!=='git'}),
          // source none: nothing is materialized; the agent starts in an empty workspace.
          ...(job.source.kind==='none'?{}:job.source.kind==='git'?{cloneGitSource:{...job.source}}:{
            materializeSource:async scratchDir=>{
              active(signal);
              if(job.source.artifact.bytes>SOURCE_ARCHIVE_INPUT_BYTES)throw error('too_large');
              // The client verifies both digest and size before returning bytes.
              const bytes=await client.fetchArtifact(job.source.artifact,{signal,job:claim.job_digest});
              active(signal);
              await extractSourceArchive(bytes,scratchDir,{gzip:job.source.artifact.media_type==='application/gzip',signal});
              active(signal);
            },
          }),
          onLog:({stream,chunk})=>{
            if(!Object.hasOwn(decoders,stream)||!(typeof chunk==='string'||chunk instanceof Uint8Array))return;
            if(signal.aborted)return;
            const bytes=typeof chunk==='string'?Buffer.byteLength(chunk):chunk.byteLength;
            if(bytes>transcriptLimit-transcriptBytes){stop('output_too_large');return;}
            transcriptBytes+=bytes;
            const decoded=decoders[stream].write(Buffer.from(chunk));
            if(stream==='stdout')stdoutLength+=decoded.length;
            transcriptEvent(stream,workspaceOutput?workspaceOutput.append(stream,decoded):decoded);
          }});
      }catch(e){
        if(retryPreparedScratch){
          try {await retryPreparedScratch();} catch { /* Keep the owner and initiating diagnostic. */ }
        }else await recordScratchCleanup(e.cleanupReceipt??e.cleanup_receipt);
        throw e;
      }finally{
        jobReturned=true;
        for(const [stream,decoder] of Object.entries(decoders)) {
          const ending=decoder.end();
          if(stream==='stdout')stdoutLength+=ending.length;
          transcriptEvent(stream,workspaceOutput?workspaceOutput.append(stream,ending):ending);
          if(workspaceOutput)transcriptEvent(stream,workspaceOutput.end(stream));
        }
      }
      cleanup=result.cleanupReceipt;
      await recordScratchCleanup(cleanup);

      if(cleanup?.removed===true){
        runEnded=monotonic();
        // Recovery may deliver output or the result intent before finally runs. Keep the measured time with that work.
        const actualUse={attemptId:attempt.attempt_id,ms:Math.min(reserved,Math.max(0,Math.round(runEnded-started)))};
        await save(saved=>({...saved,pending:{...saved.pending,actualUse}}));
      }
      unschedule(wallTimer);
      if(cleanup?.removed!==true)throw error('cessation_unverified');
      active(signal);


      const payload=await resultPayload({result,claim,chosen,prompt,knownValues,scanUnavailable,
        workspaceOutput,stdoutLength,streamedStdout,transcriptEvent,stage,signal});
      if(stopRequested){await stopPersistence;active(signal);}
      finishing=true;unschedule(timer);await renewing;active(signal);
      const idempotencyKey=randomUUID();
      if(cleanup?.removed!==true||counters.pending?.attemptId!==attempt.attempt_id)throw error('cessation_unverified');
      // This local cleanup proof and the result intent must survive the same crash.
      await save({...counters,pending:{...counters.pending,cessationVerified:{sbx_home:counters.pending?.sbx_home,attemptId:attempt.attempt_id,
        jobDigest:attempt.job_digest,generation:attempt.generation}},
        stoppedPending:counters.stoppedPending??{attempt:structuredClone(attempt),stoppedAt:iso(now()),idempotencyKey:randomUUID()},
        resultPending:{attempt:structuredClone(attempt),requester:{circle:job.circle,keyId:job.author},payload:structuredClone(payload),idempotencyKey}});
      await client.completeAttempt(attempt,payload,{signal,idempotencyKey});
      progress?.finish('done','Finished');
      await contribution('delivered');
      await save({...counters,outputPending:null,resultPending:null});
      await reportStopped().catch(e=>{
        if(!stoppedReportOwned)diagnose(claim.job_digest,e.code??'stop_report_save_failed','result');
        emit('stopping',{reason:'stop_report_pending'});
      });
      settled=true;emit('finished');
    } catch(e) {
      // The real cause stays on this computer (the borrower only sees a code); a lender needs it to fix setup.
      // Telemetry gets only the code and phase: the app strips the message at the telemetry boundary.
      const phase=finishing?'result':executed?'run':startRequested?'start':sandboxPrepared?'prepare':'before_start';
      const unverified=()=>{if(e?.code!=='cessation_unverified')diagnose(claim.job_digest,'cessation_unverified',phase);};
      cleanup??=e.cleanupReceipt??e.cleanup_receipt; // the backend's prepare reports its own cleanup as cleanup_receipt
      // A lease-expiry stop of a run without removal proof may still be going: the log must not say the work stopped.
      const stopUnproven=e?.code==='lease_expired'&&executed&&cleanup?.removed!==true;
      advisory(onDiagnostic,{at:iso(now()),job:claim.job_digest,ref:newErrorRef(),code:stopUnproven?'lease_expired_unproven':e?.code??null,phase,
        ...(e?.details&&typeof e.details==='object'?{details:e.details}:{}),
        message:String(e?.message??e)});
      if(stopRequested)await stopPersistence.catch(()=>{});
      if(cleanup?.removed===true)runEnded??=monotonic();
      if(counters.declinePending) {
        emit('declined',{reason:e.code??'release_unknown'});
      } else if(counters.resultPending) {
        if(!signal.aborted&&!retryPending(e))await rejectResult(e,{reported:true,signal});
        else emit('sending-result',{reason:e.code??'completion_unknown'});
      } else if(counters.outputPending&&!signal.aborted&&retryPending(e)) {
        emit('sending-result',{reason:e.code??'output_delivery_pending'});
      } else if(signal.aborted) {
        ceased=!unverifiedPreparedIdentity&&(!executed||cleanup?.removed===true);
        if(stopRequested&&counters.pending) {
          // A stop with proven cessation charges the time the job ran, not its whole limit (judge r10 R3). Without that
          // proof the sandbox may still be running, so the reservation stays until the stop is confirmed.
          const used=startRequested&&!agentStartDenied?Math.min(reserved,Math.max(0,Math.round((runEnded??monotonic())-started))):0;
          const refund=ceased&&reserved&&charged(job)&&counters.pending.attemptId===attempt.attempt_id?reserved-used:0;
          // Persist actual cleanup proof, never an abort/cancel acknowledgement.
          const removalObservation=observedStopRemoval(counters.pending,cleanup,attempt);
          await save({...counters,...(ceased?{ruleUsage:ruleTime(attempt.attempt_id,used,startRequested&&!agentStartDenied)}:{}),...(refund>0?{milliseconds:Math.max(0,counters.milliseconds-refund),
            requesters:requesterDelta(job.circle,job.author,0,-refund)}:{}),pending:{...counters.pending,stopReason:'stopped_by_lender',
            ...(refund>0?{reservedMs:used}:{}),
            ...(ceased?{timeAdjustmentApplied:true}:{}),
            ...(ceased?{actualUse:{attemptId:attempt.attempt_id,ms:used}}:{}),
            stopReleaseKey:counters.pending.stopReleaseKey??randomUUID(),
            stopReportKey:counters.pending.stopReportKey??randomUUID(),
            ...(removalObservation?{removalObservation}:{}),
            ...(ceased?{stoppedAt:iso(now()),cessationVerified:{sbx_home:counters.pending?.sbx_home,attemptId:attempt.attempt_id,
              jobDigest:attempt.job_digest,generation:attempt.generation}}:{})}});
          await reconcilePending();
          if(counters.pending){if(!ceased)unverified();emit('stopping',{reason:ceased?'stop_report_pending':'cessation_unverified'});}
        } else if(ceased&&!startRequested) {
          // A preparation timeout is a setup failure of this computer: it keeps its reason and takes the bounded decline path.
          if(['cleanup_pending','preparation_timeout'].includes(signal.reason?.code))await decline(attempt,signal.reason.code,claim);
          else {
            const reason=signal.reason?.code??'restart_before_start';
            await decline(attempt,reason,claim);
          }
        } else if(ceased) {
          // Release is best effort: server cancellation/fencing may have already made this terminal.
          try {await client.release(attempt,canonicalize({code:signal.reason?.code??'cancelled'}));}catch{}
          await reportStopped();
          await contribution('stopped');
          emit('stopped',{reason:signal.reason?.code??'cancelled'});
        } else {unverified();emit('stopping',{reason:'cessation_unverified'});}
      } else if(!startRequested) {
        // No start request was sent: this source/prepare error must not keep
        // reclaiming the oldest job. Cleanup proof still controls the pending
        // reservation below; a failed start acknowledgement never takes this path.
        await decline(attempt,e.code??'execution_failed',claim);
      } else {
        if(counters.outputPending) {
          const rejected={attemptId:attempt.attempt_id,output:counters.outputPending,code:e.code??'execution_failed',at:iso(now())};
          const retained=await policy.storage.retainRejectedResult?.(rejected);
          await save({...counters,...(retained?{lastResultOutcome:{...rejected,output:undefined,retained}}:{rejectedOutput:rejected}),outputPending:null});
        }
        // The borrower only ever sees the generic code; the lender's sign-in state stays local.
        const signedOut=runningHarness!==null&&agentAuthFailure({stdout:e.stdout,stderr:e.stderr,exitCode:e.exitCode});
        try {await client.fail(attempt,canonicalize({code:signedOut?'execution_failed':e.code??'execution_failed'}));}catch{}
        progress?.finish('fail','Could not finish');
        if(executed&&cleanup?.removed===true)await reportStopped();
        await contribution('failed');
        if(signedOut) {
          const harness=runningHarness;
          advisory(onEvent,{status:'agent-signed-out',harness});
          emit('failed',{reason:'agent_signed_out',label:harness+" isn't signed in inside Faravan's sandbox anymore. Sign in again on the Lend page, then lending resumes."});
        } else if(agentStartDenied&&!launchCallbackRejected)policyEvent(e.code??'internal_error');
        else emit('failed',{reason:lendingReasonCode(e.code??'execution_failed','execution_failed'),label:"This job couldn't finish: "+(e.code??'execution_failed')+'.'});
      }
    } finally {
      await transcriptPublisher?.close();
      await runContribution;
      if(runStarted&&runEnded!==null)await contribution('runtime',claim,{
        startedAt:runStarted.at,milliseconds:Math.max(0,Math.round(runEnded-runStarted.mono))});
      settled=true;unschedule(ownerPresenceTimer);cancelOwnerReturn();unschedule(providerLimitReturnTimer);unschedule(preparationTimer);unschedule(reclaimTimer);unschedule(timer);unschedule(deadlineTimer);unschedule(wallTimer);outerSignal?.removeEventListener('abort',external);
      await renewing.catch(()=>{});
      // Cleanup is a temporary hold before launch, not a withdrawal of the saved approval.
      const keepAcceptance=!stopRequested&&claim.accepted&&!startRequested&&(outerSignal?.aborted||['paused','cleanup_pending'].includes(signal.reason?.code));
      const releaseConfirmed=counters.lastDeclineOutcome?.attempt?.attempt_id===attempt.attempt_id&&counters.lastDeclineOutcome.code==='released';
      if(claim.accepted&&!startRequested&&!keepAcceptance&&!stopRequested&&!releaseConfirmed){await save({...counters,hiddenOffers:[...(counters.hiddenOffers??[]).filter(e=>e.expiresAt>now()&&e.jobDigest!==claim.job_digest),{jobDigest:claim.job_digest,expiresAt:claim.declineExpiresAt??Math.min(Date.parse(job.expires_at),now()+TEMPORARY_HOLD_REOFFER_MS),exclusionVersion:1,reason:claim.declineReason,...claim.declineEpoch}].slice(-10000)});emit('preparation-failed',{reason:'preparation_failed',label:claim.declineEpoch?"Couldn't start it; Faravan will try it again.":"Couldn't start it; it's open for others again."});}
      // A prepare failure before any handle or agent start has nothing to stop.
      // A failed prepare that reports an unproven removal keeps the reservation.
      const neverStartedSandbox=!sandboxPrepared&&!startRequested&&(cleanup==null||cleanup.removed===true);
      // The sandbox removal reaches the candidate's durable state before the journal entry that depends on it is cleared. A failed
      // write keeps the entry, so the next cycle still sees the pending attempt.
      if(retryPreparedScratch){
        try {await retryPreparedScratch();} catch {emit('stopping',{reason:'cessation_unverified'});}
      }
      const preparedRecoveryReady=preparedScratchDurable&&!unverifiedPreparedIdentity;
      let cleanupDurable=preparedRecoveryReady;

      // The candidate settles the attempt before the entries that let a restart find it are cleared. A pause before the sandbox exists, or a crash
      // between the two steps, would otherwise leave a hold with no entry and no proof of absence. A failed settlement keeps both entries.
      // Persist before any external settlement. Never turn an uncertain started run into cheap usage.
      if(counters.pending?.attemptId===attempt.attempt_id&&(!startRequested||runEnded!==null))
        await save({...counters,pending:{...preparedScratchRecovery,...counters.pending,...unverifiedPreparedIdentity,actualUse:{attemptId:attempt.attempt_id,
          ms:startRequested?Math.min(counters.pending.reservedMs,Math.max(0,Math.round(runEnded-started))):0}}});
      if(cleanupDurable&&cleanup?.removed===true&&counters.pending?.attemptId===attempt.attempt_id) {
        const timeAdjustment=pendingTimeAdjustment(counters.pending,true);
        if(Object.keys(timeAdjustment).length)
          await save({...counters,...timeAdjustment,pending:{...counters.pending,...timeAdjustment.pending}});
      }
      let settlementApplied=preparedRecoveryReady;

      if(cleanupDurable&&settlementApplied&&stoppedReportOwned&&reserved&&counters.pending?.attemptId===attempt.attempt_id&&!counters.pending.stopReason&&
         (!executed||cleanup?.removed===true||neverStartedSandbox)) {
        // A started run records its actual use only after its removal was proven (cleanup.removed), so that proof stands here.
        await save({...counters,...pendingTimeAdjustment(counters.pending,true),pending:null});
      }
      if(cleanupDurable&&settlementApplied&&stoppedReportOwned)await save({...counters,claimedPending:null,
        ...(keepAcceptance&&counters.acceptedClaim?{lastClaimOutcome:{state:'replaced',idempotencyKey:counters.acceptedClaim.intent.idempotencyKey,at:iso(now())}}:{}),
        acceptedClaim:keepAcceptance&&counters.acceptedClaim?{...counters.acceptedClaim,intent:replaceClaim(counters.acceptedClaim.intent)}:null});

      if(deniedStart===attempt.attempt_id&&counters.pending?.attemptId!==attempt.attempt_id)deniedStart=null;
      current=null;forgetAdmission();stopCurrent=null;pausePreparation=null;stopsByMs=null;stoppingNow=false;
    }
  }
  async function resultPayload({result,claim,chosen,prompt,knownValues,scanUnavailable,
    workspaceOutput,stdoutLength,streamedStdout,transcriptEvent,stage,signal,recovery=false}) {
    const send=fn=>recovery?recoveryRequest(signal,fn):fn(signal);
    const job=claim.job.payload,attempt=claim.attempt,lim=job.requirements.limits;
      const receipt=buildTaskReceipt({taskDigest:claim.job_digest,harnessId:chosen.adapter.spec.harness_id,execution:result.execution});
      if(job.source.kind==='git'&&receipt.verified_commit!==job.source.commit)throw error('git_commit_unverified');
      const requiredEvidence=limitRequirements(job.requirements).required.map(k=>EVIDENCE_LIMIT[k]);
      if(!requiredEvidence.every(k=>receipt.enforced_limits?.includes(k))||
         requiredEvidence.some(k=>receipt.unenforced?.includes(k)))throw error('limits_unenforceable');
      const diff=result.candidate?.format==='diff';
      // A pinned Git job's diff is against the commit the borrower signed; refuse any other base.
      if(diff&&job.source.kind==='git'&&result.candidate.base_commit!==job.source.commit)throw error('git_commit_unverified');
      const candidate=result.collected.find(f=>f.path===(diff?DIFF_OUTPUT:'.wf-result/result.tar.gz'))?.bytes_content;
      if(!(candidate instanceof Uint8Array))throw error('candidate_missing');
      // A typed result is the faravan-output/ tree; for message, the text is the signed transcript's final message.
      if(job.result&&diff)throw error('candidate_invalid');
      const output=job.result?{kind:job.result.kind}:undefined;
      let stat=null;
      if(diff){try{stat=diffstat(candidate);}catch{throw error('candidate_invalid');}}
      // Job context travels in the signed transcript, whose readers tolerate new event types.
      // Keep the v1 receipt shape compatible with older coordinators and requesters.
      const contextLine=receipt.job_framing_version?JSON.stringify({type:'faravan.job_context',job_framing_version:receipt.job_framing_version,workspace_path:scanUnavailable?'/workspace':workspaceOutput?.text(receipt.workspace_path)??'/workspace'})+'\n':'';
      const stopReason=result.execution.stop_reason??'done';
      const stopCopy=result.execution.host_disk_low===true?(result.execution.host_disk_reason==='host_disk_unreadable'?"Stopped by the lender: free disk space could not be read":"Stopped by the lender: the lender's computer ran low on disk space"):
        {budget:"Stopped at the lender's budget",time:"Stopped at the lender's time limit",owner:'Stopped by the lender',provider_limit:'Stopped at the provider limit'}[stopReason];
      const agentTranscript=(stopCopy?stopCopy+". Work so far follows; review it before using it.\n\n":'')+(stdoutLength===String(result.execution.stdout??'').length?streamedStdout:workspaceOutput.text(result.execution.stdout));
      const handoff=buildHandoff({prompt:Buffer.from(prompt).toString('utf8'),transcript:agentTranscript,checks:result.checks,knownValues,scanUnavailable});
      const handoffRecord=client.signContinuation?await client.signContinuation(handoff,{job_digest:claim.job_digest,attempt_id:attempt.attempt_id}):{type:'faravan.continuation',handoff};
      const handoffLine=JSON.stringify(handoffRecord)+'\n';
      const contextSuffix=contextLine?(agentTranscript&&!agentTranscript.endsWith('\n')?'\n':'')+contextLine:'';
      const continuationSuffix=(agentTranscript+contextSuffix&&!((agentTranscript+contextSuffix).endsWith('\n'))?'\n':'')+handoffLine;
      const transcript=Buffer.from(agentTranscript+contextSuffix+continuationSuffix);
      if(contextSuffix)transcriptEvent?.('stdout',contextSuffix);
      transcriptEvent?.('stdout',continuationSuffix);
      if(candidate.byteLength+transcript.byteLength>lim.output_bytes)throw error('output_too_large');
      const usage=receipt.usage;
      const publicReceipt={schema:'faravan.receipt.v1',self_reported:true,harness:chosen.adapter.spec.harness_id,
        harness_version:chosen.adapter.harnessVersion??'unknown',model:receipt.model??null,backend:chosen.report.backend_id,
        limits_applied:{...lim},egress_applied:job.requirements.egress,capabilities_applied:[...job.requirements.capabilities],
        started_at:iso(Date.parse(receipt.started_at)),finished_at:iso(Date.parse(receipt.finished_at)),
        duration_ms:receipt.duration_ms,source:structuredClone(job.source),
        ...(job.source.kind==='git'?{verified_commit:receipt.verified_commit,...(receipt.network_scope?{network_scope:receipt.network_scope}:{})}:{}),
        ...(receipt.network_kit?{kit_hosts:[...receipt.network_kit.hosts],kit_wider_hosts:[...receipt.network_kit.wider]}:{}),
        candidate_format:diff?'diff':'tree',
        ...(diff?{diffstat:stat,...(job.source.kind==='archive'?{base_tree:result.candidate.base_tree}:{})}:
          output?{}:{diff_unavailable:result.candidate?.diff_unavailable??'git_failed'}),
        egress_evidence:receipt.egress_evidence??UNOBSERVED_EGRESS,enforced_limits:receipt.enforced_limits??[],
        unenforced:[...new Set([...(receipt.unenforced??[]),...Object.keys(lim).map(k=>EVIDENCE_LIMIT[k]).filter(k=>!receipt.enforced_limits?.includes(k))])],
        usage:{input_tokens:usage?.input_tokens??null,output_tokens:usage?.output_tokens??null,total_tokens:usage?.total_tokens??null}};
      if(job.runRequest!==undefined){
        const chosen=claim.attempt.selection;
        if(!selectionSatisfies(job.runRequest,chosen))throw error('invalid_run_request');
        bindObservedAccountSelection(publicReceipt,chosen);
      }
      // The pair saved with the claim, which is also the pair the agent was started with.
      if(job.requirements.model&&!job.requirements.model.any_of.includes(publicReceipt.model))throw error('model_unverified');
      emit('sending-result');stage?.('sending');
      const artifacts=await client.uploadResultArtifacts({candidate,transcript,job:claim.job_digest,candidateMediaType:diff?'text/x-diff':'application/gzip',transcriptMediaType:'text/plain'},
        recovery?{signal,withArtifactRequest:send}:{signal});
      const context=await send(signal=>client.resultContext({signal,job:claim.job_digest}));
      const payload={schema:'faravan.result.v1',circle:job.circle,job_digest:claim.job_digest,attempt_id:attempt.attempt_id,
        generation:attempt.generation,executor:attempt.holder,roster_epoch:context.roster_epoch,submitted_at:iso(now()),...artifacts,receipt:publicReceipt,...(result.checks?{checks:result.checks}:{}),...(output?{output}:{})};
    return payload;
  }
  async function scanValues(selection,attemptId){
    try{
      const knownValues=selection?await accountExecution.credentialValues(selection,attemptId):await credentialValues();
      if(!Array.isArray(knownValues)||knownValues.some(value=>typeof value!=='string'))throw Error('credential_values_unavailable');
      return {knownValues,scanUnavailable:false};
    }catch{return {knownValues:[],scanUnavailable:true};}
  }
  async function recoverOutput(signal) {
    const spool=counters.outputPending;
    if(!spool||counters.resultPending||counters.pending)return false;
    try {
      if(typeof client.getJob==='function') {
        const view=await recoveryRequest(signal,signal=>client.getJob(spool.claim.job_digest,{signal}));
        if(view.state==='cancelled')throw Object.assign(error('cancelled'),{status:409});
      }
      const result={...spool.result,collected:spool.result.collected.map(file=>({...file,bytes_content:Buffer.from(file.bytes_content,'base64')}))};
      // Older spools saved a host path without its redaction root. Do not
      // publish that path when reconstructing their framing context.
      const workspace=result.execution.workspace_path;
      if(workspace&&workspace!=='/workspace'&&!workspace.startsWith('/workspace/'))
        result.execution={...result.execution,workspace_path:'/workspace'};
      const {knownValues,scanUnavailable}=await scanValues(spool.claim.attempt.selection,spool.claim.attempt.attempt_id);
      const workspaceOutput=workspaceTranscript('/workspace',{privateValues:knownValues,scanUnavailable});
      const payload=await resultPayload({...spool,result,prompt:Buffer.from(spool.prompt,'base64'),
        knownValues,scanUnavailable,workspaceOutput,stdoutLength:-1,streamedStdout:'',signal,recovery:true});
      await save({...counters,resultPending:{attempt:spool.claim.attempt,requester:{circle:spool.claim.job.payload.circle,
        keyId:spool.claim.job.payload.author},payload,idempotencyKey:randomUUID()}});
    } catch(e) {
      if(signal?.aborted)throw e;
      if(!retryPending(e)&&(outputValidationFinal.has(e.code)||(e.status>=400&&e.status<500&&e.status!==429))) {
        // A cancel that lands during the upload can come back as a terminal or fenced error. Ask the job, as rejectResult does.
        let cancelled=e.code==='cancelled';
        if(!cancelled&&['job_terminal','stale_attempt','lease_expired','lease_fenced','job_expired'].includes(e.code)) {
          try {cancelled=(await recoveryRequest(signal,signal=>client.getJob(spool.claim.job_digest,{signal}))).state==='cancelled';}catch{}
        }
        const rejected={attemptId:spool.claim.attempt.attempt_id,output:spool,code:cancelled?'cancelled':e.code??'completion_rejected',at:iso(now())};
        const retained=await policy.storage.retainRejectedResult?.(rejected);
        await save({...counters,outputPending:null,...(retained?{lastResultOutcome:{...rejected,output:undefined,retained}}:{rejectedOutput:rejected})});
        // A job the borrower cancelled keeps its output but is not a failure of the work.
        emit(cancelled?'stopped':'failed',{reason:rejected.code});
      } else {emit('sending-result',{reason:e.code??'output_recovery_pending'});await idle(signal);}
    }
    return true;
  }
  async function rejectResult(e,{reported=false,unconfirmed=false,signal}={}) {
    const intent=counters.resultPending;
    if(!reported)diagnose(intent.attempt.job_digest,e.code??'completion_rejected','result');
    const rejected={attemptId:intent.attempt.attempt_id,intent,output:counters.outputPending,
      code:e.code??'completion_rejected',at:iso(now())};
    const retained=policy.storage.retainRejectedResult?await policy.storage.retainRejectedResult(rejected):null;
    let cancelled=false;
    if(['job_terminal','stale_attempt','lease_expired','lease_fenced','job_expired'].includes(e.code)) {
      try {cancelled=(await recoveryRequest(signal,signal=>client.getJob(intent.attempt.job_digest,{signal}))).state==='cancelled';}catch{}
    }
    await save({...counters,outputPending:null,resultPending:null,...(!retained?{rejectedResult:rejected}:{}),
      claimedPending:counters.claimedPending?.attempt_id===intent.attempt.attempt_id?null:counters.claimedPending,
      lastResultOutcome:{attemptId:intent.attempt.attempt_id,
      code:e.code??'completion_rejected',status:e.status??0,outcome:e.outcome??'not_applied',at:iso(now()),...(retained?{retained}:{})}});
    emit(unconfirmed?'result-unconfirmed':cancelled?'stopped':'failed',{reason:e.code??'completion_rejected',
      ...(unconfirmed?{label:'Result saved on this computer. Delivery could not be confirmed.'}:{})});
  }
  // With a durable candidate, the removal is recorded there before the journal entry that carries it is cleared. A rejected write keeps the
  // entry, and the loop reports it as pending. A candidate that never reserved this attempt holds nothing, so there is nothing to record.

  async function reconcilePending(signal) {
    let pending=counters.pending;
    if(!pending)return;
    if(pending.stopReason==='stopped_by_lender'){await restoreStopRevocation(pending);pending=counters.pending;}
    if((pending.stopReason==='stopped_by_lender'||pending.gracefulStopReason==='owner')&&
       pending.executionStartRequested!==false&&pending.attempt&&pending.stopRequestKey)
      await publishStopRequest(pending.attempt,pending.stopRequestKey,signal);
    const persisted=pending.cessationVerified;
    let watching=false;
    let verified=pending.owner_scope&&persisted&&persisted.sbx_home===pending.sbx_home&&backend.isSandboxHomeCurrent?.(pending.sbx_home)!==false&&pending.attempt?.attempt_id===pending.attemptId&&
      persisted.attemptId===pending.attemptId&&persisted.jobDigest===pending.attempt.job_digest&&
      persisted.generation===pending.attempt.generation;
    // Server terminal state is NOT cessation evidence. Use the durable local
    // cleanup proof or ask the backend; in either case keep the entire reservation.
    if(!verified) {
      if(typeof backend.reconcilePending!=='function')return;
      let proof;
      try {proof=await backend.reconcilePending(structuredClone(pending),{signal,sourceDirectory:policy.storage.directory});}catch{return;}
      // A create that was dispatched and never seen, whose credentials and policy are verified revoked and whose admission wait
      // has passed, is a watch. Its sandbox is created-only (it can run no entrypoint), so this attempt never started: its
      // reservation is released as unstarted, no cessation is recorded, and the cleanup journal keeps the watch and its scratch.
      watching=proof?.watching===true&&proof.attemptId===pending.attemptId&&pending.owner_scope&&pending.prepare_contract==='create-only'&&
        pending.executionStartRequested!==true&&!pending.stopReason&&pending.gracefulStopReason!=='owner'&&
        (typeof backend.isSandboxHomeCurrent!=='function'||backend.isSandboxHomeCurrent(pending.sbx_home)!==false);
      if(watching){
        verified=false;
        pending={...pending,executionStartRequested:false};
      }else if(proof?.removed!==true||proof.attemptId!==pending.attemptId||backend.isSandboxHomeCurrent?.(proof.sbx_home)===false||pending.owner_scope&&typeof backend.isSandboxHomeCurrent==='function'&&proof.sbx_home!==pending.sbx_home){
        emit('stopping',{reason:'cessation_unverified',remediation:proof?.remediation??[]});
        return;
      }
      // The permanent fence retains this exact job's never-created evidence
      // after resource cleanup deletes its row. Preserve the watch path's
      // unstarted refund, including a restart between cleanup and settlement.
      if(!watching&&proof.never_started===true&&pending.owner_scope&&pending.prepare_contract==='create-only'&&
        pending.executionStartRequested!==true&&!pending.stopReason&&pending.gracefulStopReason!=='owner')
        pending={...pending,executionStartRequested:false};
      verified=!watching;
      if(!watching&&proof.full_charge===true){
        await save(saved=>({...saved,pending:{...saved.pending,legacyFullCharge:true,sbx_home:proof.sbx_home??saved.pending.sbx_home}}));
        pending={...pending,legacyFullCharge:true,sbx_home:proof.sbx_home??pending.sbx_home};
      }
      if(!watching&&proof.scratch_removed===false)await save(saved=>({...saved,scratchPending:
        [...(saved.scratchPending??[]).filter(row=>row.attemptId!==pending.attemptId),structuredClone(pending)]}));
    }
    // Local removal is the evidence for a durable candidate too. It is recorded there before any step below clears this entry.
    if(!watching&&(!persisted||!verified)&&pending.attempt?.attempt_id===pending.attemptId) {
      const cessationVerified={sbx_home:pending.sbx_home,attemptId:pending.attemptId,jobDigest:pending.attempt.job_digest,generation:pending.attempt.generation};
      await save({...counters,pending:{...pending,cessationVerified}});
      pending=counters.pending;verified=true;
    }
    const timeAdjustment=pendingTimeAdjustment(pending,verified);
    if(Object.keys(timeAdjustment).length) {
      await save({...counters,...timeAdjustment,pending:{...counters.pending,...timeAdjustment.pending}});
      pending=counters.pending;
    }
    // Cessation proves the sandbox is gone, not that its reservation has settled.
    // Keep the settlement inputs through failed writes and restart until the candidate owns the outcome.
    if(pending.stopReason==='stopped_by_lender') {
      // Preserve proof and exact report intents through restart/network failure.
      if(!verified)await save({...counters,pending:{...pending,stoppedAt:iso(now()),cessationVerified:{sbx_home:counters.pending?.sbx_home,
        attemptId:pending.attemptId,jobDigest:pending.attempt.job_digest,generation:pending.attempt.generation}}});
      // A denied dispatch has no run to charge. Persist the refund with its marker before
      // network reporting, so a failed Stop report or restart cannot refund the same job twice.
      if(!pending.legacyFullCharge&&pendingPreparationProof(pending)?.unused===true&&pending.agentStartDenied===true&&pending.agentStartDeniedRefunded!==true) {
        const ruleUsage=ruleTime(pending.attemptId,0,false);
        await save(saved=>({...saved,ruleUsage,...(pending.charged!==false?{jobs:Math.max(0,saved.jobs-1),
          milliseconds:Math.max(0,saved.milliseconds-pending.reservedMs),
          ...(pending.requester?{requesters:requesterDelta(pending.requester.circle,pending.requester.keyId,-1,-pending.reservedMs)}:{})}:{}),
          pending:{...saved.pending,reservedMs:0,agentStartDeniedRefunded:true}}));
        pending=counters.pending;
      }
      // Local removal is the stopping evidence; a delayed coordinator ACK is not.
      await contribution('stopped',pending);
      try {
        if(!pending.stopReleased) {
          try {
            await recoveryRequest(signal,signal=>client.release(pending.attempt,canonicalize({code:pending.stopReason}),{signal,idempotencyKey:pending.stopReleaseKey}));
          }catch(e) {
            if(signal?.aborted||retryPending(e)||
              !['stale_attempt','job_expired','job_terminal','lease_expired','lease_fenced'].includes(e.code))throw e;
            // An inactive attempt cannot be released again. Fresh verified queue
            // state may establish fencing, but NEVER establishes sandbox removal.
            const view=await recoveryRequest(signal,signal=>client.getJob(pending.attempt.job_digest,{signal})),attempt=view.current_attempt;
            const fenced=view.job_digest===pending.attempt.job_digest&&(
              ['result-accepted','cancelled','expired','failed'].includes(view.state)||
              attempt?.generation>pending.attempt.generation||
              (attempt?.attempt_id===pending.attempt.attempt_id&&attempt.generation===pending.attempt.generation&&
                ['completed','released','failed','expired','cancelled'].includes(attempt.state)));
            if(!fenced)throw e;
          }
          await save({...counters,pending:{...counters.pending,stopReleased:true}});
        }
        await recoveryRequest(signal,signal=>client.stopped(pending.attempt,{signal,stoppedAt:counters.pending.stoppedAt,idempotencyKey:pending.stopReportKey}));
      }catch(e) {
        if(signal?.aborted||retryPending(e)||!stopReportFinal.has(e.code)){emit('stopping',{reason:'stop_report_pending'});return;}
        // Cleanup and candidate accounting above already proved local cessation.
        await save({...counters,lastStopOutcome:{pending:structuredClone(counters.pending),code:e.code,at:iso(now())}});
      }
      // actualUse is written with a stop only when its cessation was proven (ceased).
      await save({...counters,...pendingTimeAdjustment(counters.pending,true),pending:null,claimedPending:null,
        lastRecovery:{attemptId:pending.attemptId,at:iso(now()),removed:true,
          ...(pending.removalObservation?{removalObservation:pending.removalObservation}:{})}},{stoppedReleaseAck:true});
      stopIntent=null;emitStopCompletion(pending.attempt);return;
    }
    const resumeAcceptance=counters.acceptedClaim&&pending.executionStartRequested===false;
    await save({...counters,...pendingTimeAdjustment(pending,verified),pending:null,
      ...(resumeAcceptance?{lastClaimOutcome:{state:'replaced',idempotencyKey:counters.acceptedClaim.intent.idempotencyKey,at:iso(now())}}:{}),
      acceptedClaim:resumeAcceptance?{...counters.acceptedClaim,intent:replaceClaim(counters.acceptedClaim.intent)}:null,
      claimedPending:counters.claimedPending?.attempt_id===pending.attemptId?null:counters.claimedPending,
      // A watched attempt owes the final stopped report, but cessation is not proven: the report waits in `watchedStops`
      // (one entry per attempt) until the watch removes the sandbox or proves it never dispatched (reconcileWatchedStops).
      stoppedPending:watching?counters.stoppedPending:counters.stoppedPending??(pending.attempt?{attempt:pending.attempt,stoppedAt:iso(now()),idempotencyKey:randomUUID()}:null),
      ...(watching&&pending.attempt?{watchedStops:[...(counters.watchedStops??[]).filter(row=>row.attemptId!==pending.attemptId),structuredClone(pending)]}:{}),
      lastRecovery:{attemptId:pending.attemptId,at:iso(now()),removed:!watching,...(watching?{watching:true}:{})}});
    if(pending.attempt&&!counters.resultPending&&!counters.outputPending&&!counters.declinePending) {
      await save({...counters,declinePending:{attempt:pending.attempt,reason:canonicalize({code:'restart_interrupted'}),idempotencyKey:randomUUID()}});
    }
  }
  // The final stopped report of a watched attempt, sent only once its watch has removed the sandbox or proved it never dispatched.
  async function reconcileWatchedStops(signal) {
    if(typeof backend.reconcilePending!=='function')return;
    for(const entry of counters.watchedStops??[]) {
      let proof;
      try {proof=await backend.reconcilePending(structuredClone(entry),{signal,sourceDirectory:policy.storage.directory});}catch{continue;}
      if(proof?.removed!==true||proof.attemptId!==entry.attemptId||backend.isSandboxHomeCurrent?.(proof.sbx_home)===false||
         entry.owner_scope&&typeof backend.isSandboxHomeCurrent==='function'&&proof.sbx_home!==entry.sbx_home)continue;
      // One report slot: a second resolved watch waits in the collection until the first report is delivered.
      if(counters.stoppedPending)continue;

      if(proof.scratch_removed===false)await save(saved=>({...saved,scratchPending:
        [...(saved.scratchPending??[]).filter(row=>row.attemptId!==entry.attemptId),structuredClone(entry)]}));
      await save(saved=>({...saved,watchedStops:(rows=>rows.length?rows:null)((saved.watchedStops??[]).filter(row=>row.attemptId!==entry.attemptId)),
        stoppedPending:saved.stoppedPending??(entry.attempt?{attempt:entry.attempt,stoppedAt:iso(now()),idempotencyKey:randomUUID()}:null)}));
    }
  }
  async function reconcileScratch(signal) {
    if(typeof backend.reconcilePending!=='function')return;
    for(const pending of counters.scratchPending??[]) {
      let proof;
      try {proof=await backend.reconcilePending(structuredClone(pending),{signal,sourceDirectory:policy.storage.directory});}catch{continue;}
      if(proof?.removed===true&&proof.scratch_removed===true&&proof.attemptId===pending.attemptId)
        await save(saved=>({...saved,scratchPending:saved.scratchPending.filter(row=>row.attemptId!==pending.attemptId)}));
    }
  }
  async function recoverResult(signal) {
    const intent=counters.resultPending;
    if(!intent)return false;
    emit('sending-result');
    try {
      await recoveryRequest(signal,signal=>client.completeAttempt(intent.attempt,intent.payload,{signal,idempotencyKey:intent.idempotencyKey}));
      await contribution('delivered',intent);
      await save({...counters,outputPending:null,resultPending:null,
        claimedPending:counters.claimedPending?.attempt_id===intent.attempt.attempt_id?null:counters.claimedPending});emit('finished');
    }catch(e) {
      if(signal?.aborted)throw e;
      if(!retryPending(e))await rejectResult(e,{signal});
      else if(unusableCompletionAck(e)&&(intent.unknownAckRetries??0)>=2) {
        // The server may have accepted this result. Retain its exact replay body
        // without blocking other work or declaring the finished work failed.
        await rejectResult(e,{unconfirmed:true,signal});
      } else {
        if(unusableCompletionAck(e))
          await save({...counters,resultPending:{...intent,unknownAckRetries:(intent.unknownAckRetries??0)+1}});
        emit('sending-result',{reason:e.code??'completion_unknown'});await idle(signal);}
    }
    return true;
  }
  async function recoverStopped(signal) {
    const intent=counters.stoppedPending;
    if(!intent)return false;
    try {
      await recoveryRequest(signal,signal=>client.stopped(intent.attempt,{signal,stoppedAt:intent.stoppedAt,idempotencyKey:intent.idempotencyKey}));
      await save({...counters,stoppedPending:null});
    } catch(e) {
      if(signal?.aborted)throw e;
      // Only a definitive refusal ends the report; other refusals (an active attempt, clock skew, a stale roster) can clear.
      // A reply that cannot be read is bounded like an unknown completion ACK: the server has committed, and retrying
      // forever would block other work.
      const unreadable=!retryPending(e)&&!(e.status>=400);
      if(stopReportFinal.has(e.code)||(unreadable&&(intent.unreadableRetries??0)>=2)) {
        await save({...counters,stoppedPending:null});
      } else {
        if(unreadable||intent.unreadableRetries)
          await save({...counters,stoppedPending:{...intent,unreadableRetries:unreadable?(intent.unreadableRetries??0)+1:0}});
        emit('stopping',{reason:'stop_report_pending'});await idle(signal);}
    }
    return true;
  }
  const claimLabels={conflict:'Taken by someone else',job_expired:'Expired',retry_exhausted:'This job has used all its tries',requirements_unsupported:"This computer can't meet what the job needs"};
  const ruleUsage=(id,replaying=null)=>{
    const history=(counters.ruleUsage??[]).filter(e=>e.at>now()-7*86400000&&e.id===id&&e.ran!==false&&
      !(replaying&&e.jobDigest===replaying.jobDigest&&e.acceptedAt===replaying.acceptedAt&&!(e.finished===true&&e.ms>0)));
    return {weeklyJobs:history.length,weeklyMs:history.reduce((n,e)=>n+e.ms,0),
      dailyJobs:history.filter(e=>lenderDayKey(e.at,cfg.timeZone)===dayKey()).length,
      dailyMs:history.filter(e=>lenderDayKey(e.at,cfg.timeZone)===dayKey()).reduce((n,e)=>n+e.ms,0)};
  };
  async function hideWaitingOffer(jobDigest,expiresAt) {
    pendingHiddenOffers.set(jobDigest,expiresAt);
    await save(saved=>({...saved,hiddenOffers:[...(saved.hiddenOffers??[]).filter(e=>e.expiresAt>now()&&e.jobDigest!==jobDigest),
      {jobDigest,expiresAt,permanent:true,exclusionVersion:1}].slice(-10000)}));
    emit('hidden',{jobDigest,label:'Hidden on this computer. Others can still run it.'});
  }
  async function hideOffer(view) {
    await hideWaitingOffer(view.job_digest,Date.parse(view.job.payload.expires_at));
  }
  // Approval belongs to the signed job on this computer, across accounts and execution choices.
  const holdsConsent=async(jobDigest,expiresAt)=>{
    const fresh=await policy.storage.get();
    if(fresh)counters={...counters,hiddenOffers:fresh.hiddenOffers??[],ruleUsage:fresh.ruleUsage??[],jobConsents:fresh.jobConsents??[]};
    return Number.isFinite(expiresAt)&&expiresAt>now()&&
      (counters?.jobConsents??[]).some(e=>e.jobDigest===jobDigest&&!e.revoked&&e.expiresAt>now());
  };
  const rememberConsent=(jobDigest,expiresAt)=>Number.isFinite(expiresAt)?save(saved=>({...saved,
    jobConsents:[...(saved.jobConsents??[]).filter(e=>e.expiresAt>now()&&e.jobDigest!==jobDigest),{jobDigest,expiresAt}].slice(-200)})):null;
  const revokeConsent=jobDigest=>save(saved=>({...saved,
    jobConsents:(saved.jobConsents??[]).map(e=>e.jobDigest===jobDigest?{...e,revoked:true}:e)}));
  // An offer that leaves the review without the person's answer is not hidden: the next offer poll shows it again.
  // Each job, cause and step is reported once, so an offer that keeps coming back does not fill the error log.
  const returnedOffers=new Set();
  function offerReturns(jobDigest,code,stage) {
    const key=JSON.stringify([jobDigest,code,stage]);
    if(returnedOffers.has(key))return;
    returnedOffers.add(key);if(returnedOffers.size>1000)returnedOffers.delete(returnedOffers.values().next().value);
    advisory(onDiagnostic,{at:iso(now()),job:jobDigest,ref:newErrorRef(),code,phase:'before_claim',details:{stage}});
  }
  async function reviewOffer(view,ready,signal) {
    const job=view.job.payload;
    waitingOffers.set(view.job_digest,view);
    if(job.prompt.bytes>65536){emit('offer-unavailable',{reason:'prompt_preview_too_large',label:'This request is too large to preview safely.'});return null;}
    const review=new AbortController(),combined=AbortSignal.any([signal,review.signal]);
    let resolveClaim;const claimResult=new Promise(resolve=>{resolveClaim=resolve;});
    let stage='prompt',watching=null;
    try {
      let prompt=promptCache.get(job.prompt.digest);
      if(!prompt){prompt=Buffer.from(await client.fetchArtifact(job.prompt,{signal,job:view.job_digest})).toString('utf8');promptCache.set(job.prompt.digest,prompt);if(promptCache.size>100)promptCache.delete(promptCache.keys().next().value);}
      stage='approval';
      emit('offer',{jobDigest:view.job_digest,label:'An offer is ready to review',offer:true});
      const watch=async()=>{while(!combined.aborted){await wait(10000,combined);const latest=await client.getJob(view.job_digest,{signal:combined});if(latest.state!=='queued'){offerReader.forget(view.job_digest);emit('offer-taken',{jobDigest:view.job_digest,reason:'conflict',label:'Taken by someone else'});review.abort(error('offer_taken'));return;}}};
      watching=watch().catch(e=>{if(!combined.aborted)review.abort(e);});
      const offerExpiresAt=Date.parse(job.expires_at);
      const accepted=await holdsConsent(view.job_digest,offerExpiresAt)?true:await Promise.race([Promise.resolve().then(()=>approve({jobDigest:view.job_digest,job:structuredClone(job),prompt,harness:ready.adapter.spec.harness_id,
        startsNow:true,offer:true,claimResult,legacyHold:false,credentialInGuest:ready.adapter.spec.credential_in_guest===true,sourceFiles:null,expiresAt:offerExpiresAt,signal:combined})),
        wait(Math.max(0,offerExpiresAt-now()),combined).then(()=>false)]);
      active(signal);
      if(accepted===true){await rememberConsent(view.job_digest,offerExpiresAt);waitingOffers.delete(view.job_digest);return {view,resolveClaim};}
      if(accepted===false||accepted?.declined===true)await revokeConsent(view.job_digest);
      if(accepted?.withdrawn===true) {
        waitingOffers.delete(view.job_digest);if(!combined.aborted)offerReturns(view.job_digest,accepted.code,stage);
        resolveClaim({accepted:false,code:accepted.code});return {retryReview:true};
      }
      // A Skip or an expired card: hide the offer on this computer.
      stage='hide';
      await hideOffer(view);waitingOffers.delete(view.job_digest);resolveClaim({accepted:false,code:'hidden'});return null;
    }catch(e){
      waitingOffers.delete(view.job_digest);
      if(!combined.aborted)offerReturns(view.job_digest,e?.code??'internal_error',stage);
      resolveClaim({accepted:false,code:e?.code??'cancelled',status:e?.status,retryable:e?.retryable});return {retryReview:true};
    }
    finally{review.abort();await watching;}
  }
  async function afterAudit(job,ready,rule,signal) {
    let why;
    try {why=await gate(job,signal);}catch(e){return signal?.aborted?'cancelled':e.code??'cancelled';}
    if(why)return why;
    const still=matchingRule(cfg.standingRules,job,ready.adapter.spec.harness_id,{now:now(),timeZone:cfg.timeZone,usage:ruleUsage});
    return still&&JSON.stringify(still)===JSON.stringify(rule)?null:'rule_changed';
  }
  // One pass over the open offers, in order: the first standing-rule offer admissible now (or null), and the manual offers a
  // person must decide. `known` only deduplicates manual cards. A rescan passes announce:false and stays quiet, so it never
  // overwrites the status of an open card with a paused notice.
  // The automatic choice priced for a card that waits for review, by job digest. A card with no entry was never priced.
  const heldOffers=new Map();
  async function screen(items,ready,signal,{known=new Set(),announce=true}={}) {
    // Discovery also retries a failed hide when no other state needs saving.
    if(pendingHiddenOffers.size)await save(saved=>saved).catch(()=>{});
    const hidden=[...(counters.hiddenOffers??[]),...(counters.declined??[])].filter(excluded),manual=[];
    const openDigests=new Set(items.map(view=>view.job_digest));
    for(const digest of heldOffers.keys()) if(!openDigests.has(digest)) heldOffers.delete(digest);
    for(const view of items) {
      heldOffers.delete(view.job_digest);
      const job=view.job.payload;
      if((pendingHiddenOffers.get(view.job_digest)??0)>now()||hidden.some(e=>e.jobDigest===view.job_digest)) continue;
      // A local account change may arrive while the coordinator's offer poll is waiting.
      // Screen the returned offer against current accounts, rather than the poll's old advertisement.
      Object.assign(cfg,policy);validateRequesterLimits(cfg.requesterLimits);active(signal);await budget();
      const current=await availability(job,{cached:true});
      if(current.decision.kind!=='lend'){
        if(heldOffers.size<32)heldOffers.set(view.job_digest,{id:view.job_digest,circle:job.circle,agent:ready.adapter.spec.harness_id,
          reason:current.reason,until:current.until,expiresAt:Date.parse(job.expires_at),...keyed(ready.adapter.spec.harness_id)});
        if(current.reason==='requester_limit'&&announce)await save({...counters,lastRequesterLimit:{circle:job.circle,keyId:job.author,day:dayKey(),at:iso(now())}});
        continue;
      }
      if(!current.adapter)continue;
      const advertisement=current.advertisement;
      const compatible=canSatisfy(job.requirements,advertisement,{job});
      if(!compatible.ok)continue;
      if(job.budget_v1?.effort===undefined&&current.adapter.run?.model&&job.requirements.model&&!job.requirements.model.any_of.includes(current.adapter.run.model)) continue;
      if(job.source.kind==='git'&&current.report.pinned_git!==true) continue;
      const rule=matchingRule(cfg.standingRules,job,current.adapter.spec.harness_id,{now:now(),timeZone:cfg.timeZone,usage:ruleUsage});
      const quotaReason=rule?await quotaGate(current.adapter,true,view.job_digest,job,matchingRun(advertisement,job),Date.parse(job.expires_at)):null;
      const automatic=Boolean(rule)&&!quotaReason&&(!cfg.idleOnly||await ownerAbsentFor(view.job_digest));
      if(automatic)return {selected:{view,ruleId:rule.id,rule:structuredClone(rule)},manual};
      // An open review card is not permission, but must not mask a newly matching
      // standing rule. Only deduplicate after the fresh automatic admission path.
      // Keep its original card/pricing while it still requires a manual decision.
      if(known.has(view.job_digest))continue;
      // A timed rule hold, rate window, or owner activity stays with the standing rule and is checked again on the next pass.
      // In ask mode, objective/evidence holds stay reviewable; the accepted claim still needs a fresh durable reservation.
      if(rule) {
        if(cfg.mode==='auto'&&quotaReason&&heldOffers.size<32) heldOffers.set(view.job_digest,{
          id:view.job_digest, circle:job.circle, agent:ready.adapter.spec.harness_id,
          reason:quotaReason, expiresAt:Date.parse(job.expires_at), ...keyed(ready.adapter.spec.harness_id),
        });
        if(announce&&quotaReason==='confirming_surplus')emit('paused',{reason:quotaReason,label:'Waiting for allowance to stay available for 10 minutes.'});
        continue;
      }
      if(typeof approve==='function'&&manual.length<32){manual.push(view);}
    }
    return {selected:null,manual};
  }
  // The offer poll is a coordinator long poll that only a new offer ends. A local limit or rule change (`reconfigure`)
  // ends it through `wake`, and the loop starts again: availability and the policy are read afresh there. The next read
  // then takes the open offers at once instead of waiting for news that will not come (judge r12 R12-3: a raised limit
  // took 58 s to admit a waiting offer).
  let offersChanged=false,legacyPairIndex=0;
  async function readOffers(signal) {
    const woken=new AbortController(),takeNow=offersChanged;
    offersChanged=false;
    wake=()=>woken.abort();
    try {return await observePoll(()=>offerReader.read({signal:signal?AbortSignal.any([signal,woken.signal]):woken.signal,waitSeconds:takeNow?0:undefined}));}
    catch(error) {
      if(signal?.aborted||!woken.signal.aborted)throw error;
      offersChanged=true;
      return null;
    }
    finally {wake=null;}
  }
  async function chooseOffer(ready,signal,ownerPage=null) {
    // Pool workers share hides and standing-rule use. Refresh them before
    // discovery, while the shared write queue remains the admission authority.
    const fresh=await policy.storage.get();
    if(fresh)counters={...counters,hiddenOffers:fresh.hiddenOffers??[],ruleUsage:fresh.ruleUsage??[],jobConsents:fresh.jobConsents??[]};
    const page=ownerPage??await readOffers(signal);
    if(!page)return null;
    if(page.legacy){emit('legacy-hold',{label:page.label,legacyHold:true});return {legacy:true};}
    let {selected,manual}=await screen(page.items,ready,signal);
    if(!selected&&manual.length) {
      const inbox=new AbortController(),combined=AbortSignal.any([signal,inbox.signal]);
      closeOffers=()=>inbox.abort(error('paused'));
      const offered=new Set(),pending=new Map();
      const showCard=view=>{
        offered.add(view.job_digest);
        const review=reviewOffer(view,ready,combined).then(async result=>{
          if(result?.retryReview){await wait(cfg.pollMs,combined);offered.delete(view.job_digest);return {digest:view.job_digest,result:null};}
          return {digest:view.job_digest,result};
        });
        offerReviews.set(view.job_digest,review);
        review.then(()=>{
          if(offerReviews.get(view.job_digest)===review)offerReviews.delete(view.job_digest);
          acceptedOfferReviews.delete(review);
        },()=>{
          if(offerReviews.get(view.job_digest)===review)offerReviews.delete(view.job_digest);
          acceptedOfferReviews.delete(review);
        });
        pending.set(view.job_digest,review);
      };
      manual.slice(0,32).forEach(showCard);
      try {
        let poll=null;
        // A card waits for a person; a standing-rule offer must not wait behind it. While cards are open, screen the open
        // offers again on every poll, as the idle loop does, and take the first one whose rule admits it now.
        while(!selected&&pending.size&&!combined.aborted) {
          poll??=wait(cfg.pollMs,combined).then(()=>null,()=>null);
          const next=await Promise.race([...pending.values(),poll]);
          if(next){pending.delete(next.digest);if(next.result){selected=next.result;break;}active(signal);continue;}
          poll=null;
          if(combined.aborted)break;
          let again;
          try {again=await screen(ownerPage?[]:(await observePoll(()=>offerReader.read({signal:combined,waitSeconds:0}))).items,ready,combined,{known:offered,announce:false});}
          catch(e){if(combined.aborted)break;throw e;}
          if(combined.aborted)break;
          if(again.selected){selected=again.selected;break;}
          for(const view of again.manual){if(pending.size>=32)break;showCard(view);}
        }
      }finally{
        closeOffers=null;inbox.abort(error('inbox_closed'));
        for(const outcome of await Promise.allSettled(pending.values()))if(outcome.status==='fulfilled')
          outcome.value.result?.resolveClaim({accepted:false,code:'inbox_closed',label:'Another job was accepted on this computer.'});
      }
    }
    active(signal);if(!selected)return null;
    const job=selected.view.job.payload;
    if(job.runRequest!==undefined) {
      // An offer can be held through an account change. The first claim must use what
      // this lender offers now. Approval belongs to the job on this computer.
      const current=await available(job,{discoveryReport:ready.report}).catch(cause=>{
        selected.resolveClaim?.({accepted:false,code:cause?.code??'readiness_changed'});
        throw cause;
      });
      if(!current||
        !canSatisfy(job.requirements,current.advertisement,{job}).ok) {
        selected.resolveClaim?.({accepted:false,code:'readiness_changed'});
        return null;
      }
      ready=current;
    }
    if(await gate(job,signal)){selected.resolveClaim?.({accepted:false,code:'readiness_changed'});return null;}
    // The rule was matched before the quota and idle checks awaited. gate() has just reloaded policy, so accept
    // automatically only if that same rule still matches now; otherwise the offer waits for a person.
    if(selected.ruleId&&matchingRule(cfg.standingRules,job,ready.adapter.spec.harness_id,{now:now(),timeZone:cfg.timeZone,usage:ruleUsage})?.id!==selected.ruleId)return null;
    const intent={jobDigest:selected.view.job_digest,job:structuredClone(selected.view.job),advertisement:claimAdvertisement(ready.advertisement,job),leaseSeconds:cfg.leaseSeconds,idempotencyKey:randomUUID(),state:'created-unsent',acceptedAt:now(),ruleId:selected.ruleId??null,wallSeconds:job.requirements.limits.wall_seconds,decisionId:randomUUID()};
    // A standing rule's acceptance is recorded, with the rule as it granted the job, before any claim intent exists.
    // Claim retries and restarts reuse this intent, so one acceptance keeps one receipt identity.
    if(selected.rule) {
      const entry={id:intent.decisionId,jobDigest:intent.jobDigest,circle:job.circle,requester:job.author,at:intent.acceptedAt,rule:selected.rule};
      try {await onDecision(entry);}
      catch(cause){throw Object.assign(error('audit_unavailable'),{cause});}
      // The write awaited: Pause, Off, cancellation or a rule edit may have landed meanwhile. Only the same rule, still
      // matching under live policy, may create the first claim intent; otherwise the receipt is marked not applied.
      const fenced=await afterAudit(job,ready,selected.rule,signal);
      if(fenced){await onDecisionNotApplied({...entry,reason:fenced}).catch(()=>{});active(signal);return null;}
    }
    acceptedOfferResult=selected.resolveClaim??null;
    await save({...counters,claimPending:intent});
    return intent;
  }
  async function chooseOwnerOffer(signal) {
    if(!offerReader||!cfg.ownKeyId)return null;
    const page=await readOffers(signal);
    // A blind legacy claim can reserve a stranger’s job. Never send native capacity there.
    if(!page||page.legacy)return null;
    for(const view of page.items) {
      if(!await ownJob(view.job.payload))continue;
      const ready=await available(view.job.payload);
      if(!ready||!canSatisfy(view.job.payload.requirements,ready.advertisement,{job:view.job.payload}).ok)continue;
      if(await chooseOffer(ready,signal,{items:[view],legacy:false}))return ready;
    }
    return null;
  }
  async function main(signal) {
    if(activeStores.has(policy.storage))throw error('lender_already_running');
    activeStores.add(policy.storage);running=true;counters=null;claimDraft=null;forgetAdmission();
    let releaseStore,releaseBackendSession;
    try {
      releaseStore=await policy.storage.acquire?.();
      releaseBackendSession=backend.beginLendingSession?.({accountKey,slot:accountSlot});
      while(!signal?.aborted&&!await readyBudget(signal,{recoveryOnly:true})){}
      active(signal);
      // Startup admission cannot depend on a saved cessation flag. Global
      // availability admits unrelated targets without certifying old debt gone.
      // Each prepare/dispatch still needs its own target and deadline checks.
      let foreignSeen=startupForeignDiagnostics.get(backend);
      if(!foreignSeen){foreignSeen=new Set();startupForeignDiagnostics.set(backend,foreignSeen);}
      const reconcileAdmission=backend.reconcileLendingAdmission??backend.reconcileOwnedSandboxes;
      while(!signal?.aborted&&typeof reconcileAdmission==='function') {
        let proof;
        try {proof=await reconcileAdmission.call(backend,{signal});}catch{}
        for(const name of proof?.foreign??[])if(!foreignSeen.has(name)) {
          foreignSeen.add(name);diagnose(null,'cessation_unverified','before_claim');
        }
        // A cached promise can settle before another session releases debt.
        // Validate again at consumption, not only when the flight settles.
        const admitted=proof?.admission_allowed===true
          ? backend.isOwnedSandboxAdmissionCurrent?.(proof)===true
          : proof?.admission_allowed!==false&&proof?.removed===true&&backend.isOwnedSandboxProofCurrent?.(proof)!==false;
        if(admitted)break;
        const waiting=await availability(null,{cached:true,startupWait:true});
        emit('waiting_for_sandbox',{reason:waiting.reason,until:waiting.until,remediation:proof?.remediation??[]});
        await idle(signal,DECLINE_BACKOFF_MS);
      }
      while(!signal?.aborted) {
        Object.assign(cfg,policy);
        void recoverObservation(signal);
        await reconcilePending(signal);
        if(await recoverOutput(signal))continue;
        if(await recoverResult(signal))continue;
        if(await recoverDecline(signal))continue;
        if(await recoverStopped(signal))continue;
        await reconcileScratch(signal);
        await reconcileWatchedStops(signal);

        if(counters.acceptedClaim&&!counters.pending&&!counters.resultPending&&!counters.declinePending&&!counters.claimPending) {
          if(!await readyBudget(signal))continue;
          const accepted=counters.acceptedClaim,claim=accepted.claim??{},job=claim.job?.payload??null;
          const intent={...accepted.intent,job:accepted.intent.job??accepted.claim?.job,state:accepted.intent.state??(accepted.claim?.attempt?'confirmed':'created-unsent'),wallSeconds:accepted.intent.wallSeconds??accepted.claim?.job?.payload?.requirements?.limits?.wall_seconds};
          if(intent.state==='confirmed')intent.claimResult=structuredClone(accepted.claim);
          // Limits and a pause refuse before the expiry check, so expiry is read from the job itself before any wait.
          if(job&&Date.parse(job.expires_at)<=now()){await save({...counters,acceptedClaim:null});policyEvent('job_expired');continue;}
          let why=await gate(null,signal);if(why){policyEvent(why);await idle(signal);continue;}
          // A waiting acceptance shares the idle cooldown; the fresh checks below authorize its new claim.
          let discovery;
          try{discovery=await backend.lenderCapabilities({cached:true,observation:true,idle:true});}catch{active(signal);}
          if(!discovery?.available){policyEvent(discovery?.reason??'sandbox_not_ready');await idle(signal);continue;}
          // Check the accepted job itself before claiming it. A hold that clears by itself waits here with the
          // acceptance kept; a lasting refusal or a changed agent still claims, and the check after the claim declines it.
          why=job?await gate(job,signal,claim.job_digest):null;
          if(job&&!why) {
            let found;
            // Eligibility may wait on the candidate; only the fresh guard after that wait authorizes a claim.
            try{found=await availability(job,{discoveryReport:discovery});}
            catch(e){if(signal.aborted)throw e;found={reason:'sandbox_not_ready'};}
            // The allowance is not read here: the post-claim check and the durable reserve decide it at execution time.
            if(!found.adapter)why=found.reason??'readiness_changed';
          }
          if(why==='job_expired'){await save({...counters,acceptedClaim:null});policyEvent(why);continue;}
          if(why){policyEvent(why);await idle(signal);continue;}
          try{await save({...counters,claimPending:intent,acceptedClaim:null});}
          catch(e){
            if(e.code!=='rule_limit'){await storageWait(e,signal);continue;}
            emit('paused',{reason:'rule_limit',label:'This accepted job is waiting for its standing-rule limit.'});await idle(signal);continue;
          }
        }
        if(counters.claimedPending&&!counters.pending&&!counters.claimPending) {
          const attempt=counters.claimedPending;

          await save({...counters,declinePending:{attempt,
            reason:canonicalize({code:'restart_interrupted'}),idempotencyKey:randomUUID()},claimedPending:null});
          continue;
        }
        if(counters.pending){emit('stopping',{reason:counters.pending.cessationVerified&&counters.pending.stopReason?'stop_report_pending':'cessation_unverified'});await idle(signal);continue;}
        if(cfg.recoveryOnly){await idle(signal);continue;}
        if(!await readyBudget(signal))continue;
        // An uncertain claim is replayed verbatim even if local policy changed.
        if(!counters.claimPending||(['created-unsent','sent-uncertain'].includes(claimIntent(counters.claimPending).state)&&!uncertainClaim(claimIntent(counters.claimPending)))) {
          const delay=Math.max(0,declineUntilMono-monotonic());
          if(delay){await idle(signal,Math.min(delay,DECLINE_BACKOFF_MS));continue;}
          if(!offerReader&&claimExclusions().length>=MAX_DECLINED){
            emit('paused',{reason:'decline_exclusions_full',label:'You skipped many jobs; new ones will appear as old ones expire'});await idle(signal,DECLINE_BACKOFF_MS);continue;
          }
        }
        let found;
        try{found=await observeAvailable({cached:true});}
        catch(e){
          active(signal);noteReadiness(false);
          emit('waiting_for_sandbox',{reason:'sandbox_not_ready',label:waitLabel('sandbox_not_ready')});await idle(signal);continue;
        }
        // A host that did not answer its feature list cannot take a claim: wait for it, as the decision does.
        if(found.adapter&&found.hostUnread)found={...found,adapter:null,reason:'circle_unreachable'};
        let ready=found.adapter?found:null;
        noteReadiness(ready!==null,found.reason);
        if(!ready&&found.ownerOnly&&counters.claimPending?.job){
          // A selected owner job cannot be described by job-less discovery. Its held eligibility still shares idle evidence.
          let discovery;
          try{discovery=await backend.lenderCapabilities({cached:true,observation:true,idle:true});}catch{active(signal);}
          if(discovery?.available){found=await availability(counters.claimPending.job.payload,{discoveryReport:discovery});ready=found.adapter?found:null;}
        }
        if(!ready&&found.ownerOnly&&!counters.claimPending) {
          try {ready=await chooseOwnerOffer(signal);}
          catch(e){if(signal?.aborted)break;diagnose(null,e.code??'offers_failed','before_claim');emit('failed',{reason:e.code??'offers_failed'});await failureWait(e,signal);continue;}
        }
        if(!ready&&(!counters.claimPending||(['created-unsent','sent-uncertain'].includes(claimIntent(counters.claimPending).state)&&!uncertainClaim(claimIntent(counters.claimPending))))){emit('waiting_for_sandbox',{reason:found.reason,until:found.until??null,nextAction:found.nextAction,detail:found.detail,
          label:found.label??waitLabel(found.reason,{until:found.until??null}),
          ...(['host_disk_low','host_disk_unreadable'].includes(found.reason)&&found.diskDetail?{label:'Cannot lend: '+found.diskDetail}:{})});await idle(signal);continue;}
        // Auto offer discovery happens before the lender knows a job's model. Do not let a
        // job-less quota preflight veto discovery; screen() gates each signed job with its
        // model, and the claim/start path repeats that job-specific check. Legacy claim
        // mode has no such screen, so it must keep the automatic preflight.
        if(!counters.claimPending&&!(offerReader&&cfg.mode==='auto')) {
          const why=await quotaGate(ready.adapter,!offerReader&&cfg.mode==='auto');
          if(why) {
            policyEvent(why);await idle(signal);continue;
          }
        }
        if(!counters.claimPending)emit('idle');
        if(!counters.claimPending&&offerReader) {
          try {const selected=await chooseOffer(ready,signal);if(!selected){await idle(signal);continue;}}
          catch(e){if(signal?.aborted)break;diagnose(null,e.code??'offers_failed','before_claim');emit('failed',{reason:e.code??'offers_failed'});await failureWait(e,signal);continue;}
        }
        pollController=new AbortController();
        const combined=signal?AbortSignal.any([signal,pollController.signal]):pollController.signal;
        let claim;
        if(!counters.claimPending){
          try{await save({...counters,claimPending:{advertisement:claimAdvertisement(ready.advertisement,null,legacyPairIndex++),exclude:claimExclusions(),leaseSeconds:cfg.leaseSeconds,idempotencyKey:randomUUID(),state:'created-unsent'}});}
          catch(e){pollController=null;await storageWait(e,signal);continue;}
        }
        try {
          let intent=claimIntent(counters.claimPending);
          claim=await sendClaim(intent,combined);
          intent=claimIntent(intent);
          if(claim===CLAIM_PARKED){await idle(signal);continue;}
          // Resolve uncertainty or reuse the known response, then check whether the rule still authorizes preparation.
          if(claim&&intent.ruleId){
            const fresh=await policy.storage.get();
            if(fresh)counters={...counters,ruleUsage:fresh.ruleUsage??[],hiddenOffers:fresh.hiddenOffers??[]};
            Object.assign(cfg,policy);
            const rule=matchingRule(cfg.standingRules.filter(r=>r.id===intent.ruleId),claim.job.payload,intent.advertisement.harnesses[0],{now:now(),timeZone:cfg.timeZone,usage:id=>ruleUsage(id,intent)});
            if(!rule){

              await save({...counters,claimPending:null,lastClaimOutcome:claimEnd(intent,'dropped'),claimedPending:claim.attempt,acceptedClaim:null});
              await decline(claim.attempt,'standing_rule_changed',claim);
              acceptedOfferResult?.({accepted:false,code:'standing_rule_changed'});acceptedOfferResult=null;continue;
            }
          }
          if(claim){claim.claimAdvertisement=intent.advertisement;}
          if(claim&&intent.jobDigest){claim.accepted=true;claim.automatic=Boolean(intent.ruleId);claim.acceptedHarness=intent.advertisement.harnesses[0];}

          await save({...counters,claimPending:null,lastClaimOutcome:{state:'dropped',terminalState:intent.state,idempotencyKey:intent.idempotencyKey,at:iso(now())},claimedPending:claim?.attempt??null,acceptedClaim:claim?.accepted?{intent,claim:structuredClone(claim)}:null,
            ...(claim?.accepted&&intent.ruleId?{ruleUsage:reserveStandingRuleTime(counters.ruleUsage??[],intent,claim.attempt.attempt_id,claim.job.payload.requirements.limits.wall_seconds*1000,now())}:{})});
          if(claim?.accepted)emit('offer-accepted',{jobDigest:claim.job_digest,attemptId:claim.attempt.attempt_id,requester:claim.job.payload.author});
          acceptedOfferResult?.({accepted:true,attemptId:claim?.attempt.attempt_id});acceptedOfferResult=null;
        }
        catch(e){
          // A crash may outlast the execution lease without revoking consent. A verified
          // unstarted, expired attempt can be replaced only while that same job is open.
          if(e.code==='lease_expired'&&observedExecutionTime(e.committedAttempt)===null&&counters.claimPending?.jobDigest) {
            let view;
            try {view=await client.getJob(counters.claimPending.jobDigest,{signal});}
            catch(checkError){if(!signal?.aborted&&retryPending(checkError)){emit('accepting',{label:'Still confirming this job with the circle.'});await idle(signal);continue;}}
            if(view?.state==='queued'&&view.current_attempt?.attempt_id===e.committedAttempt.attempt_id&&observedExecutionTime(view.current_attempt)===null) {
              if(!ready){policyEvent(found.reason??'sandbox_not_ready');await idle(signal);continue;}
              const previous=counters.claimPending,next=replaceClaim(previous);
              await save({...counters,claimPending:next,lastClaimOutcome:{state:'replaced',idempotencyKey:previous.idempotencyKey,at:iso(now())},acceptedClaim:null});
              emit('accepting',{label:'Restoring the accepted job.'});continue;
            }
          }
          if(e.code==='conflict'&&counters.claimPending?.jobDigest)offerReader?.forget(counters.claimPending.jobDigest);
          const retryClaim=retryPending(e)&&!e.claimRejected;
          if(!retryClaim||signal?.aborted){acceptedOfferResult?.({accepted:false,code:e.code??'claim_failed',status:e.status,retryable:e.retryable,label:claimLabels[e.code]});acceptedOfferResult=null;}
          if(signal?.aborted)break;
          if(!retryClaim&&!signal?.aborted)diagnose(counters.claimPending?.jobDigest??null,e.code??'claim_failed','before_claim');
          if(e.claimRejected||e.status>=400&&!retryPending(e)) {
            const abandoned=counters.claimedPending;

            await save({...counters,claimPending:null,acceptedClaim:null,lastClaimOutcome:{...claimEnd(counters.claimPending,'dropped'),code:e.code??'claim_rejected'},
              ...(abandoned?{claimedPending:null}:{}),
              ...(e.committedAttempt?{declinePending:{attempt:structuredClone(e.committedAttempt),
                reason:canonicalize({code:e.code??'claim_rejected'}),idempotencyKey:randomUUID(),rejectedClaim:true}}:{})});
          }
          emit(retryClaim?'accepting':'failed',{reason:e.code??'claim_failed',...(retryClaim?{label:'Still confirming this job with the circle.'}:claimLabels[e.code]?{label:claimLabels[e.code]}:{})});await failureWait(e,signal);continue;
        }
        finally{pollController=null;}
        if(claim&&ready) {
          const run=()=>execute(claim,ready,signal);
          await (releaseBackendSession?.run?releaseBackendSession.run(run):run());
          // The stop path already tried its durable report. Give an uncertain
          // acknowledgement a cancellable retry delay rather than replaying at
          // the top of the loop immediately; restart still replays the same key.
          if(counters.pending?.stopReleased&&counters.pending.cessationVerified)
            await wait(cfg.pollMs,signal);
        }
        else if(claim)await decline(claim.attempt,'readiness_changed',claim);
        else await idle(signal);
      }
    }catch(e){if(!signal?.aborted){diagnose(null,e.code??'lender_failed','before_claim');emit('failed',{reason:e.code??'lender_failed'});throw e;}}
    finally{try{releaseBackendSession?.();await releaseStore?.();}finally{activeStores.delete(policy.storage);running=false;current=null;heldOffers.clear();forgetAdmission();stopsByMs=null;stoppingNow=false;emit('paused');}}
  }
  return {
    start(signal){if(running||loop)return loop;loop=main(signal).finally(()=>{loop=null;});return loop;},
    /** Whether an offer of `job` arriving now would be admitted: null, or the reason it would be refused. Read-only. A
     * lender whose loop is not running admits nothing; one that is working on a job takes no other (judge r10 R5, R9).
     * An account that cannot run a job (signed out, disabled, backend unavailable) refuses it: see observeAvailable. */
    admits(job){
      if(!running)return 'lender_stopped';
      if(!counters)return 'lender_starting';
      if(counters.day>dayKey())return 'invalid_counter_store';
      if(current)return 'busy';
      Object.assign(cfg,policy);
      // A new day's offer is counted against an empty day, as the loop's own next budget() will count it.
      const usage=counters.day===dayKey()?counters:{...counters,jobs:0,milliseconds:0,requesters:{}};

      // The account's own answer from the loop's last check: null, or why it cannot take a job. Unknown or stale is not proof of ready.
      if(!admission||now()-admission.at>AVAILABILITY_MAX_AGE_MS)return 'lender_starting';
      return admission.reason;
    },
    /** A known identity or settings change: forget the last availability, then re-prove it now (the pool awaits this). */
    async refreshAdmission() {
      readinessEpoch++;forgetAdmission();backend.invalidateLendingCapabilities?.();
      if(counters)await save({...counters,declined:(counters.declined??[]).filter(row=>row.epoch===undefined)});
      // While a job runs the answer is 'busy' whatever it says; completion forgets and re-proves the account.
      if(running&&counters&&!current)await observeAvailable().catch(()=>{});
    },
    /** A limit or rule change: an idle loop starts again now and reads its open offers without waiting (judge r12 R12-3). */
    reconfigure(){offersChanged=true;offerReader?.invalidate();wake?.();},
    pause(){paused=true;closeOffers?.();const preparing=pausePreparation?.();wake?.();
      // The pause label hides the state a running job had. Keep that state so resume can show it again.
      if(state.status!=='paused')pausedFrom={status:state.status,label:state.label};
      emit('paused',{label:current&&!preparing?'Lending will pause after this job.':LABELS.paused});},
    hideWaitingOffers(){return Promise.all([...waitingOffers.values()].map(view=>hideWaitingOffer(view.job_digest,Date.parse(view.job.payload.expires_at))));},
    acceptWaitingOffer(jobDigest){waitingOffers.delete(jobDigest);const review=offerReviews.get(jobDigest);if(review)acceptedOfferReviews.add(review);},
    settleAcceptedOffers(){return Promise.allSettled([...acceptedOfferReviews]);},
    /** Whether every sandbox this lender started is proven gone. A pending recovery needs the durable proof bound to its own attempt. */
    cessation(){
      const pending=counters?.pending;
      if(!pending)return {proven:true,attemptId:null};
      const proof=pending.cessationVerified;
      return {attemptId:pending.attemptId,proven:Boolean(proof)&&proof.sbx_home===pending.sbx_home&&backend.isSandboxHomeCurrent?.(pending.sbx_home)!==false&&pending.attempt?.attempt_id===pending.attemptId&&
        proof.attemptId===pending.attemptId&&proof.jobDigest===pending.attempt.job_digest&&proof.generation===pending.attempt.generation};
    },
    ownsSignedAccountAttempt(attemptId){
      return current?.attempt?.attempt_id===attemptId&&current?.job?.payload?.runRequest!==undefined;
    },
    async stopCurrentJob(attemptId){
      if(typeof attemptId!=='string'||current?.attempt?.attempt_id!==attemptId||!await stopCurrent?.())throw error('no_current_job');
      wake?.();return this.snapshot;
    },
    resume(){if(stopIntent||counters?.pending?.stopReason)throw error('lending_recovery_required');if(paused){readinessEpoch++;forgetAdmission();}paused=false;wake?.();
      // Nothing emitted since the pause means the label is still the pause label. Show the running state it hid while the job
      // is still current; otherwise show idle until the loop reports its next state.
      if(state.status==='paused'&&cfg.enabled){const from=pausedFrom&&current?pausedFrom:{status:'idle'};emit(from.status,from.label?{label:from.label}:{});}
      pausedFrom=null;
    },
    get snapshot(){return structuredClone({...state,counters,
      currentJobDigest:current?.job_digest??null,heldOffers:running&&!paused&&cfg.enabled?[...heldOffers.values()].filter(offer=>offer.expiresAt>now()):[],current:current?.attempt?.attempt_id??null,currentRequester:current?.job?.payload?.author??null,agent:current?.agent??null,stopsBy:current?stopsByMs:null,stopping:current?stoppingNow:false});},
    getState(){return this.snapshot;},
  };
}

// Selection describes configured execution, never a substitute for observation.
export function bindObservedAccountSelection(receipt,selection) {
  if(!selection)throw error('candidate_invalid');
  if(receipt.model==null||receipt.model!==selection.modelId)throw error('model_unverified');
  receipt.selection=structuredClone(selection);
}
