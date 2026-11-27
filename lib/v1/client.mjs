import {signHandoff} from './continuation.mjs';
import {verifyLease} from './account-authority.mjs';
import { randomBytes } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';

// Everything a person's own action (Send, Stop, Delete) asks the host, reads included, runs inside this scope. The
// host lets such requests use the share of this computer's request budget that background reads cannot touch, and
// a busy-host refusal is waited out within a bounded budget instead of reaching the person (judge r10 R2).
const personScope = new AsyncLocalStorage();
export const asPersonAction = fn => personScope.run(true, fn);
import * as p from '../protocol/index.mjs';
import { isVersion, TRANSCRIPT_RELAY_LIMITS, MODEL_EFFORT_PAIRS_CAPABILITY, AUTO_RUN_CAPABILITY, RUN_REQUEST_CAPABILITY, DESIGNATED_MEMBER_CAPABILITY } from './versions.mjs';
import { selectionSatisfies } from './run-request.mjs';
import { isOperationKey } from './outcome.mjs';
import {receivedResponse} from './host-failure.mjs';

const JSON_LIMIT = 262144;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TERMINAL = new Set(['result-accepted', 'cancelled', 'expired', 'failed']);
// P22: the host capabilities a signed job needs beyond protocol 1.0 (S5.4's `network` and `registries`).
const hostCapabilitiesFor = payload => [
  ...(payload?.requirements && (payload.requirements.network !== undefined || payload.requirements.registries !== undefined) ? ['network_requirements_v1'] : []),
  // A typed result (and source none) is refused by an older host's validator as unsupported_version; say why first.
  ...(payload?.result !== undefined ? ['results_v1'] : []),
  ...(payload?.budget_v1!==undefined?['budget_v1']:[]),
  ...(payload?.budget_v1?.effort!==undefined||payload?.auto_run_v1!==undefined?[MODEL_EFFORT_PAIRS_CAPABILITY]:[]),
  ...(payload?.auto_run_v1!==undefined?[AUTO_RUN_CAPABILITY]:[]),
  ...(payload?.runRequest!==undefined?[RUN_REQUEST_CAPABILITY]:[]),
  ...(payload?.designated_member!==undefined?[DESIGNATED_MEMBER_CAPABILITY]:[]),
  ...(payload?.requirements?.capabilities?.includes('filtered_git_v1') ? ['filtered_git_v1'] : []),
  ...(payload?.source_manifest ? ['source_manifest_v1'] : []),
  ...(payload?.source_manifest?.project_name ? ['source_project_name_v1'] : []),
  ...(payload?.working_directory ? ['working_directory_v1'] : []),
  ...(payload?.parent !== undefined ? ['parent_link_v1'] : []),
  ...(payload?.audience ? ['frozen_audience_v1'] : []),
];

// The job kinds this client's validator accepts in a job list (see GET /jobs in docs/protocol/v1.md).
const LIST_CAPABILITIES = ['results_v1','budget_v1','parent_link_v1','source_manifest_v1','source_project_name_v1','working_directory_v1','filtered_git_v1','decline_count_v1',AUTO_RUN_CAPABILITY,RUN_REQUEST_CAPABILITY,DESIGNATED_MEMBER_CAPABILITY];

export class ClientError extends Error {
  constructor(code, {status = 0, retryable = false, problem = null, outcome = 'not_applied', cause, operationKey} = {}) {
    super(code, {cause}); this.name = 'ClientError';
    Object.assign(this, {code, status, retryable, problem, outcome});
    if (operationKey) this.operationKey = operationKey;
  }
}
// A transport may reuse its error. Keep the original for diagnosis and attach
// retry authority to this Delete alone.
function unknownDelete(cause,key) {
  const error=new ClientError(cause?.code??'network_error',{status:cause?.status??0,
    retryable:cause?.retryable??false,problem:cause?.problem??null,cause,outcome:'unknown',operationKey:key});
  if(cause?.responseReceived===true)error.responseReceived=true;
  if(Number.isSafeInteger(cause?.retryAfterSeconds)&&cause.retryAfterSeconds>0)error.retryAfterSeconds=cause.retryAfterSeconds;
  const response=receivedResponse(cause?.receivedResponse);
  if(response)error.receivedResponse=response;
  return error;
}
const need = (condition, code = 'invalid_response') => { if (!condition) throw new ClientError(code); };
const checked = result => { need(result.ok, result.code); return result; };
const integer = (n, low, high) => need(Number.isSafeInteger(n) && n >= low && n <= high, 'invalid_request');
const digestPath = value => { need(typeof value === 'string' && DIGEST.test(value), 'invalid_request'); return value.slice(7); };
const uuidPath = value => { need(typeof value === 'string' && UUID.test(value), 'invalid_request'); return value; };
const abort = signal => { if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); };
function pause(ms, signal) {
  abort(signal);
  return new Promise((resolve, reject) => {
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', stop); resolve(); };
    const stop = () => { clearTimeout(timer); signal.removeEventListener('abort', stop); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', stop, {once:true});
  });
}
function exact(value, keys, optional=[]) {
  need(value && typeof value === 'object' && !Array.isArray(value));
  need(keys.every(k => Object.hasOwn(value,k))&&Object.keys(value).every(k=>keys.includes(k)||optional.includes(k)));
}
function timestamp(value) {
  need(typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value));
  const ms=Date.parse(value);
  need(Number.isFinite(ms)&&new Date(ms).toISOString()===value.slice(0,-1)+'.000Z');
}
function attemptShape(a, jobDigest) {
  exact(a, ['attempt_id','job_digest','generation','holder','state','claimed_at','lease_expires_at','execution_started_at','reason','compute_stopped','stopped_at'],['execution_observed_at','selection']);
  if(a.selection!==undefined)need(selectionSatisfies({schemaVersion:1,models:'any',effortId:null},a.selection));
  uuidPath(a.attempt_id); digestPath(a.job_digest); digestPath(a.holder);
  integer(a.generation,1,Number.MAX_SAFE_INTEGER);
  need(!jobDigest || a.job_digest === jobDigest, 'wrong_job_digest');
  need(['active','completed','released','failed','expired','cancelled'].includes(a.state));
  need(typeof a.compute_stopped === 'boolean');
  timestamp(a.claimed_at); timestamp(a.lease_expires_at);
  if(a.execution_started_at!==null) timestamp(a.execution_started_at);
  if(a.execution_observed_at!==undefined&&a.execution_observed_at!==null) timestamp(a.execution_observed_at);
  need(a.execution_observed_at===undefined||a.execution_observed_at===null||typeof a.execution_started_at==='string');
  if(a.stopped_at!==null) timestamp(a.stopped_at);
  need(a.reason===null||typeof a.reason==='string'&&[...a.reason].length>=1&&[...a.reason].length<=4096);
  return a;
}
function stopRequestShape(value, attempt) {
  exact(value,['attempt_id','job_digest','generation','requested_at']);
  uuidPath(value.attempt_id);digestPath(value.job_digest);
  integer(value.generation,1,Number.MAX_SAFE_INTEGER);timestamp(value.requested_at);
  need(value.attempt_id===attempt.attempt_id&&value.job_digest===attempt.job_digest&&
    value.generation===attempt.generation,'invalid_response');
  return value;
}
function progressEntry(entry, jobDigest) {
  const stage = entry && typeof entry === 'object' && Object.hasOwn(entry, 'stage');
  exact(entry, stage ? ['job','attempt','seq','at','stage','elapsed_s'] : ['job','attempt','seq','at','step','kind']);
  need(entry.job === jobDigest); uuidPath(entry.attempt); integer(entry.seq,1,Number.MAX_SAFE_INTEGER); timestamp(entry.at);
  if (stage) {
    need(['preparing','agent','checks','screenshots','sending'].includes(entry.stage));
    integer(entry.elapsed_s,0,Number.MAX_SAFE_INTEGER);
    return;
  }
  need(typeof entry.step==='string'&&[...entry.step].length>=1&&[...entry.step].length<=120);
  need(['step','done','fail'].includes(entry.kind));
}
async function boundedBody(response, maxBytes, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > maxBytes)) {
    await response.body?.cancel(); throw new ClientError('payload_too_large');
  }
  const chunks = []; let lengthRead = 0;
  if (response.body) {
    const reader = response.body.getReader();
    const stop = () => { void reader.cancel(signal.reason).catch(()=>{}); };
    signal?.addEventListener('abort', stop, {once:true});
    try {
      for (;;) {
        abort(signal); const {done,value} = await reader.read(); abort(signal);
        if (done) break;
        lengthRead += value.byteLength;
        if (lengthRead > maxBytes) { await reader.cancel(); throw new ClientError('payload_too_large'); }
        chunks.push(Buffer.from(value));
      }
    } finally { signal?.removeEventListener('abort',stop); reader.releaseLock(); }
  }
  need(length === null || Number(length) === lengthRead, 'size_mismatch');
  return Buffer.concat(chunks,lengthRead);
}

/**
 * Caller owns durable operation intents and an atomic per-root/circle roster cache.
 * clock returns Unix seconds; random(n) returns n cryptographically random bytes.
 * clientVersion is an optional dotted release version; omission reports unknown, never the host's version.
 */
export function createClient({
  origin, circle, deviceKey, pinnedRootFingerprint, rosterCache, lanMode=false, clientVersion=null, immutableCache=null,
  fetch: transport = globalThis.fetch, clock = () => Math.floor(Date.now()/1000), downloadSlot = null,
  random = randomBytes, logger, sleep = pause, retry = {}, onRosterFetched = null,
  maxArtifactBytes = 16*1024*1024, maxTranscriptBytes = 4*1024*1024,
} = {}) {
  need(typeof lanMode==='boolean'&&p.validateOrigin(origin,{lanMode}).ok,'invalid_origin');
  uuidPath(circle); digestPath(pinnedRootFingerprint);
  need(clientVersion===null||isVersion(clientVersion),'invalid_request');
  need(typeof transport === 'function' && rosterCache && typeof rosterCache.get === 'function' && typeof rosterCache.set === 'function', 'invalid_request');
  const privateKey = deviceKey?.privateKey ?? deviceKey;
  const publicKey = p.exportPublicKey(privateKey), keyId = p.fingerprint(publicKey);
  const base = origin + '/v1/circles/' + circle;
  const maxAttempts = retry.maxAttempts ?? 4, baseMs = retry.baseMs ?? 100, capMs = retry.capMs ?? 5000;
  const writeBusyBudgetMs = retry.writeBusyBudgetMs ?? 20000;
  integer(maxAttempts,1,10); integer(baseMs,0,60000); integer(capMs,0,60000); integer(writeBusyBudgetMs,0,600000);
  integer(maxArtifactBytes,0,1073741824); integer(maxTranscriptBytes,0,maxArtifactBytes);
  let artifactHead; let state; let loaded; let rosterQueue = Promise.resolve();
  const now = () => { const n=clock(); integer(n,0,Number.MAX_SAFE_INTEGER); return n; };
  const randomBuffer = n => { const b = random(n); need(b instanceof Uint8Array && b.length === n, 'invalid_random'); return Buffer.from(b); };
  const operationKey = key => { const k = key ?? randomBuffer(24).toString('base64url'); need(isOperationKey(k),'invalid_request'); return k; };
  const load = async () => {
    if (!loaded) loaded = Promise.resolve(rosterCache.get()).then(value => {
      state = structuredClone(value ?? {current:null,history:[],highestAcceptedEpoch:0});
      need(Array.isArray(state.history ?? []),'invalid_roster_cache');
      if (state.current) {
        const v = historicalRoster(state.current);
        checked(p.checkRosterEpoch(v.roster,state.highestAcceptedEpoch ?? 0,state.highestAcceptedDigest));
        state.highestAcceptedEpoch = v.roster.epoch; state.highestAcceptedDigest = v.digest;
      } else need((state.highestAcceptedEpoch ?? 0) === 0,'invalid_roster_cache');
      state.history ??= [];
    });
    await loaded; return state;
  };
  function checkTransport(roster) {
    need((roster.lan_mode===true)===(lanMode===true),'transport_mismatch');
    // The roster's `coordinator` pins the incumbent host. A member client bound to another member's
    // own serving origin (owner-offline topology) accepts the same signed roster when the roster
    // itself records that origin for a member: the address it reached is one the roster names.
    need(roster.coordinator===undefined&&!lanMode||roster.coordinator===origin
      ||roster.members.some(member=>member.origin===origin),'wrong_origin');
  }
  function historicalRoster(envelope) {
    const issued = Date.parse(envelope?.payload?.issued_at)/1000;
    const v=checked(p.verifyRoster(envelope,{rootFingerprint:pinnedRootFingerprint,circle,now:()=>issued}));
    checkTransport(v.roster);return v;
  }
  // fetchMeta is given only by the current-roster GET: it alone proves a fresh, verified network read (D9).
  async function acceptRoster(envelope,fetchMeta=null) {
    await load();
    const task = rosterQueue.then(async () => {
      const v = checked(p.verifyRoster(envelope,{rootFingerprint:pinnedRootFingerprint,circle,now,
        highestAcceptedEpoch:state.highestAcceptedEpoch ?? 0,highestAcceptedDigest:state.highestAcceptedDigest,previousAuthorityChain:state.current?.payload.authority_chain,previousRoster:state.current?.payload}));
      checkTransport(v.roster);
      const history = state.history.filter(r=>r.payload.epoch !== v.roster.epoch);
      if (state.current && state.current.payload.epoch !== v.roster.epoch &&
          !history.some(r=>r.payload.epoch===state.current.payload.epoch)) history.push(state.current);
      const next = {current:structuredClone(envelope),history,highestAcceptedEpoch:v.roster.epoch,highestAcceptedDigest:v.digest};
      await rosterCache.set(structuredClone(next)); state = next;
      // Members and digest come from this verified roster, never a later cache read. The caller's failure never fails the accept.
      if(fetchMeta&&onRosterFetched) {
        try {onRosterFetched({circle,fetchedAt:fetchMeta.fetchedAtMs,epoch:v.roster.epoch,rosterDigest:v.digest,members:structuredClone(v.roster.members??[])});}catch{/* the receipt is lost; the next fetch renews */}
      }
      return envelope;
    });
    rosterQueue = task.catch(()=>{}); return task;
  }
  async function current(signal) {
    await load(); need(state.current,'roster_required');
    const verify=()=>p.verifyRoster(state.current,{rootFingerprint:pinnedRootFingerprint,circle,now,
      highestAcceptedEpoch:state.highestAcceptedEpoch,highestAcceptedDigest:state.highestAcceptedDigest,previousAuthorityChain:state.current?.payload.authority_chain,previousRoster:state.current?.payload});
    let v=verify();
    if(!v.ok&&['roster_expired','roster_stale','roster_unknown'].includes(v.code)) {
      await api.refreshRoster({signal}); v=verify();
    }
    checked(v);checkTransport(v.roster);
    need(p.findMember(v.roster,keyId),'not_member'); return v.roster;
  }
  async function rosterAt(epoch,signal) {
    integer(epoch,1,Number.MAX_SAFE_INTEGER); await load();
    let roster=[state.current,...state.history].find(r=>r?.payload?.epoch===epoch);
    if(roster) return historicalRoster(roster);
    // A historical read cannot roll back the accepted current roster.
    if(epoch>state.highestAcceptedEpoch) await api.refreshRoster({signal});
    need(epoch<=state.highestAcceptedEpoch,'roster_unknown');
    roster=[state.current,...state.history].find(r=>r?.payload?.epoch===epoch);
    if(roster) return historicalRoster(roster);
    const envelope=await request('GET','/rosters/'+epoch,{signal,refresh:true});
    const valid=historicalRoster(envelope); need(valid.roster.epoch===epoch,'roster_mismatch');
    const task=rosterQueue.then(async()=>{
      const existing=[state.current,...state.history].find(r=>r?.payload?.epoch===epoch);
      if(existing) { need(historicalRoster(existing).digest===valid.digest,'roster_stale'); return; }
      const next={...state,history:[...state.history,structuredClone(envelope)]};
      await rosterCache.set(structuredClone(next)); state=next;
    });
    rosterQueue=task.catch(()=>{}); await task; return valid;
  }
  async function signed(kind,envelope,signal) {
    await load(); const epoch = envelope?.payload?.roster_epoch;
    const valid = await rosterAt(epoch,signal);
    const member = p.findMember(valid.roster,envelope?.signature?.key_id);
    need(member,'not_member');
    const v = checked(p.verifyEnvelope(kind,envelope,member.public_key));
    checked(p.checkCircle(v.payload,circle)); return v;
  }
  async function request(method,path,{body,signal,idempotencyKey,bootstrap=false,refresh=false,proposedEpoch,binary=false,maxBytes=JSON_LIMIT,mediaType='',expectedMediaType,headers:extraHeaders,personAction=false,deleteOutcome}={}) {
    abort(signal); await load();
    const bytes = body === undefined ? Buffer.alloc(0) : body instanceof Uint8Array ? Buffer.from(body) : Buffer.from(p.canonicalize(body));
    if (!mediaType) need(bytes.length<=JSON_LIMIT,'payload_too_large');
    const key = method === 'POST' ? operationKey(idempotencyKey) : '';
    const read=method==='GET'||method==='HEAD';
    const target = base+path, contentType = read ? '' : mediaType ? 'application/octet-stream' : 'application/json';
    let refreshed=false,busyWaitedMs=0;
    // Historical response evidence is request-local, never a later attempt's outcome.
    let lastReceivedResponse;
    const person=personAction||personScope.getStore()===true;
    for (let index=0; index<maxAttempts; index++) {
      abort(signal);
      const epoch = proposedEpoch ?? (bootstrap ? 0 : refresh ? state.highestAcceptedEpoch ?? 0 : (await current(signal)).epoch);
      const headers = {'Faravan-Proof':p.buildRequestProof({circle,roster_epoch:epoch,method,target,body:bytes,
        content_type:contentType,artifact_media_type:mediaType,idempotency_key:key,created:now(),nonce:randomBuffer(24).toString('base64url')},privateKey,{lanMode})};
      if(extraHeaders) Object.assign(headers,extraHeaders);
      // Unsigned like Faravan-Version: it only chooses which share of this device's own budget a request may use.
      if(person) headers['Faravan-Priority']='person';
      // This unsigned compatibility hint is not an authentication or security boundary.
      headers['Faravan-Version']=clientVersion??'unknown';
      if(contentType) headers['Content-Type']=contentType;
      if(!read) headers['Content-Length']=String(bytes.length);
      if(mediaType) headers['Faravan-Media-Type']=mediaType;
      if(key) headers['Idempotency-Key']=key;
      let response, error, retryAfter=0;
      // A host admits few downloads per device at once; past that it answers 429. Queue them here instead.
      const release = method==='GET'&&binary&&downloadSlot ? await downloadSlot(signal) : null;
      try { try {
        if(deleteOutcome) { deleteOutcome.dispatched=true; deleteOutcome.refused=false; }
        response = await transport(target,{method,headers,body:read?undefined:bytes,signal,redirect:'manual'});
        need(!(response.status>=300&&response.status<400),'redirect_refused');
        if(method==='HEAD'&&response.ok) {
          need(response.headers.get('content-type')?.split(';')[0]==='application/octet-stream','invalid_content_type');
          const length=response.headers.get('content-length');need(length!==null&&/^(0|[1-9][0-9]*)$/.test(length),'size_mismatch');
          const bytes=Number(length);need(Number.isSafeInteger(bytes)&&bytes<=maxBytes,'payload_too_large');
          return {bytes,media_type:response.headers.get('faravan-media-type')};
        }
        const raw = method==='HEAD'?Buffer.alloc(0):await boundedBody(response,response.ok&&binary?maxBytes:JSON_LIMIT,signal);
        if(response.ok) {
          if(response.status===204) { need(raw.length===0); return null; }
          need(response.headers.get('content-type')?.split(';')[0] === (binary?'application/octet-stream':'application/json'),'invalid_content_type');
          if(binary&&expectedMediaType!==undefined) need(response.headers.get('faravan-media-type')===expectedMediaType,'artifact_mismatch');
          return binary ? raw : p.strictParse(raw);
        }
        let problem = null;
        if(response.headers.get('content-type')?.split(';')[0]==='application/problem+json') {
          try { problem=p.strictParse(raw); } catch { /* Preserve HTTP failure classification. */ }
        }
        const retryable=response.status===429||response.status>=500;
        error = new ClientError(typeof problem?.code==='string'?problem.code:'http_error',
          {status:response.status,retryable,problem,outcome:problem?.outcome??'unknown',operationKey:key});
        // A refusal proves only this attempt did not apply. It cannot undo an earlier lost reply.
        if(deleteOutcome) {
          deleteOutcome.refused=response.status>=400&&response.status<500&&problem?.outcome==='not_applied';
          if(!deleteOutcome.refused)deleteOutcome.uncertain=true;
          error.outcome=deleteOutcome.uncertain?'unknown':'not_applied';
        }
        const header=response.headers.get('retry-after');
        if(header && /^\d+$/.test(header)) retryAfter=Number(header)*1000;
        else if(header) retryAfter=Math.max(0,Date.parse(header)-now()*1000)||0;
        error.receivedResponse = lastReceivedResponse = receivedResponse({status: response.status, code: error.code,
          outcome: error.outcome, operationKey: key,
          ...(retryAfter > 0 ? {retryAfterSeconds: Math.ceil(retryAfter/1000)} : {})});
      } catch (cause) {
        const ambiguousWrite=method==='POST'&&(path==='/jobs'||path.endsWith('/complete')||Boolean(deleteOutcome));
        if(deleteOutcome)deleteOutcome.uncertain=true;
        if(cause instanceof ClientError) {
          if(deleteOutcome){
            const own=unknownDelete(cause,key);
            if(response?.ok)own.responseReceived=true;
            throw own;
          }
          if(response?.ok)cause.responseReceived=true;
          if(ambiguousWrite)Object.assign(cause,{outcome:'unknown',operationKey:key});
          if(!ambiguousWrite)abort(signal);
          throw cause;
        }
        if(cause instanceof p.ProtocolError) {
          const invalid=new ClientError(cause.code,{cause,operationKey:key,
            outcome:ambiguousWrite?'unknown':'not_applied'});
          if(response?.ok) invalid.responseReceived=true;
          if(!ambiguousWrite)abort(signal);
          throw invalid;
        }
        // A deadline of an already-started transport preserves earlier response
        // evidence, never that earlier attempt's outcome. Ordinary cancellation
        // and deadlines with no history keep their existing identity/precedence.
        const transportDeadline=lastReceivedResponse&&signal?.aborted&&signal.reason?.name==='TimeoutError';
        if(!ambiguousWrite&&!transportDeadline)abort(signal);
        error=new ClientError('network_error',{retryable:true,outcome:'unknown',
          cause:transportDeadline?signal.reason:cause,operationKey:key});
        if(lastReceivedResponse)error.receivedResponse=receivedResponse(lastReceivedResponse);
        // Do not enter another wait/loop whose abort would discard this evidence.
        if(transportDeadline)throw error;
      } } finally { release?.(); }
      if(!refreshed&&!bootstrap&&!refresh&&proposedEpoch===undefined&&
          ['roster_stale','roster_unknown'].includes(error.code)&&error.status===409) {
        refreshed=true; await api.refreshRoster({signal});
        // Exactly one extra proof attempt, preserving the immutable body and key.
        index--; continue;
      }
      if(retryAfter>0) error.retryAfterSeconds=Math.ceil(retryAfter/1000);
      const jitter=randomBuffer(4).readUInt32BE()/0x100000000;
      const delay=Math.max(retryAfter,Math.min(capMs,baseMs*2**index)*(0.5+jitter/2));
      // A request of a person's own action (Send, Stop, Delete) that a busy host refused with 429 was not applied: it
      // waits as the host asks and tries again, past maxAttempts but never past writeBusyBudgetMs of waiting in total,
      // before anyone sees a refusal (judge r9 O-B, r10 R2). Every wait counts, at least 250 ms each, so the loop always
      // ends. A write sends the same idempotency key again, so a retry cannot apply it twice. Background requests
      // (heartbeat, progress, transcript, page reads) keep the normal attempts: their own schedules retry, and some
      // 429s there are interval limits.
      const busyWrite=person&&error.retryable&&error.status===429&&error.code==='rate_limited';
      const wait=busyWrite?Math.max(delay,250):delay;
      if(busyWrite){
        if(busyWaitedMs+wait>writeBusyBudgetMs) throw error;
        busyWaitedMs+=wait; if(index+1===maxAttempts) index--;
      } else if(!error.retryable||index+1===maxAttempts) throw error;
      // Do not clamp Retry-After downward. Very long server delays are surfaced for caller scheduling.
      if(!Number.isFinite(wait)||wait>2147483647) throw error;
      logger?.debug?.({event:'retry',status:error.status,code:error.code,attempt:index+1});
      // A local deadline that ends this wait leaves with the host's last answer (rate_limited, say), not as a bare
      // TimeoutError: that would read as a host that is not responding, while the host answered and asked us to wait.
      // A person's cancellation (any other reason) still leaves as itself.
      try { await sleep(Math.ceil(wait),signal); }
      catch (cause) { if((error.status||lastReceivedResponse)&&signal?.aborted&&signal.reason?.name==='TimeoutError') throw error; throw cause; }
    }
  }
  const VERIFIED_JOBS_MAX=4096, verifiedJobs=new Map();
  async function verifyJobView(view,expected,signal) {
    exact(view,['job_digest','job','state','attempts_started','current_attempt','result_digest',...(Object.hasOwn(view??{},'declined_count')?['declined_count']:[])]);
    if(Object.hasOwn(view,'declined_count'))integer(view.declined_count,0,Number.MAX_SAFE_INTEGER);
    digestPath(view.job_digest); need(!expected||view.job_digest===expected,'wrong_job_digest');
    // A signed job is immutable and verified against the roster of its own epoch, so one success holds forever. Keyed by the
    // exact envelope bytes, so a different envelope claiming the same digest is never trusted from here.
    const envelopeKey=p.digestBytes(Buffer.from(p.canonicalize(view.job)));
    if(verifiedJobs.get(envelopeKey)!==view.job_digest) {
      const v=await signed('job',view.job,signal);
      need(v.digest===view.job_digest,'wrong_job_digest'); checked(p.checkAuthor(v.payload,v.key_id));
      if(verifiedJobs.size>=VERIFIED_JOBS_MAX) verifiedJobs.delete(verifiedJobs.keys().next().value);
      verifiedJobs.set(envelopeKey,view.job_digest);
    }
    need(['queued','claimed',...TERMINAL].includes(view.state));
    integer(view.attempts_started,0,Number.MAX_SAFE_INTEGER);
    if(view.current_attempt!==null) attemptShape(view.current_attempt,view.job_digest);
    if(view.result_digest!==null) digestPath(view.result_digest);
    return view;
  }
  // P22: what the host says it is and can do. A host that predates P22 (or a field it omits) reads as {faravan:null,min_member:null,capabilities:[]}.
  let hostProfile=null;
  const capabilities=async(opts={})=>{
    if(hostProfile&&!opts.refresh)return hostProfile;
    const caps=await request('GET','/capabilities',{signal:opts.signal});
    // A reply that is not an object is a host that answered badly, not a host that is down.
    need(caps!==null&&typeof caps==='object'&&!Array.isArray(caps));
    const version=value=>typeof value==='string'&&/^\d+\.\d+\.\d+$/.test(value)?value:null;
    hostProfile={faravan:version(caps.faravan),protocol:typeof caps.protocol==='string'?caps.protocol:null,min_member:version(caps.min_member),
      capabilities:Array.isArray(caps.capabilities)?caps.capabilities.filter(c=>typeof c==='string'&&/^[a-z0-9_]{1,40}$/.test(c)).slice(0,32):[],
      artifact_head:caps.artifact_head===true};
    artifactHead=hostProfile.artifact_head;
    return hostProfile;
  };
  const hostSupports=name=>hostProfile?.capabilities.includes(name)===true;
  async function requireTranscriptRelay(signal) {
    let host;
    try {host=await capabilities({signal});}
    catch(error) {if(error.status===404)throw new ClientError('host_too_old');throw error;}
    need(host.capabilities.includes('transcript_relay_v1'),'host_too_old');
  }
  async function acceptClaim(claim,capabilities,signal,expected) {
    let committedAttempt;
    try {
      exact(claim,['job_digest','job','attempt']); digestPath(claim.job_digest); need(!expected||claim.job_digest===expected,'wrong_job_digest');
      attemptShape(claim.attempt,claim.job_digest); need(claim.attempt.holder===keyId,'executor_mismatch');
      // Reconcile cleanup identifiers independently of the untrusted job.
      const latest=attemptShape(await request('GET','/attempts/'+uuidPath(claim.attempt.attempt_id),{signal}),claim.job_digest);
      checked(p.checkAttempt(latest,claim.attempt)); need(latest.holder===keyId,'executor_mismatch');
      committedAttempt=latest;
      const signedJob=await signed('job',claim.job,signal); checked(p.checkAuthor(signedJob.payload,signedJob.key_id));
      need(signedJob.digest===claim.job_digest,'wrong_job_digest');
      const roster=await current(); need(p.findMember(roster,signedJob.payload.author),'not_member');
      checked(p.canSatisfy(signedJob.payload.requirements,capabilities,{job:signedJob.payload}));
      // A replayed acknowledgement is not a renewed lease.
      need(latest.state==='active'&&Date.parse(latest.lease_expires_at)>now()*1000,'lease_expired');
      return {...claim,attempt:latest};
    } catch(cause) {
      abort(signal);
      const error=normalize(cause);
      if(error instanceof ClientError&&!error.retryable) {
        error.claimRejected=true;
        if(committedAttempt) error.committedAttempt=structuredClone(committedAttempt);
      }
      throw error;
    }
  }
  const getJob = async (jobDigest,opts={}) => verifyJobView(await request('GET','/jobs/'+digestPath(jobDigest),{...opts,headers:{...opts.headers,'Faravan-Client-Capabilities':'decline_count_v1'}}),jobDigest,opts.signal);
  async function uploadArtifact(input,mediaType,opts={}) {
    need(input instanceof Uint8Array,'invalid_request');
    const bytes=Buffer.from(input); need(bytes.length<=maxArtifactBytes,'payload_too_large');
    need(['application/gzip','text/x-diff','text/plain','application/x-ndjson'].includes(mediaType),'invalid_request');
    const ref={digest:p.digestBytes(bytes),bytes:bytes.length,media_type:mediaType};
    if(artifactHead===undefined) {
      try {artifactHead=(await capabilities({signal:opts.signal})).artifact_head;}
      catch(error){if(!(error instanceof ClientError)||![404,405].includes(error.status))throw error;artifactHead=false;}
    }
    try {
      if(artifactHead) {
        const existing=await request('HEAD','/artifacts/'+digestPath(ref.digest),{...opts,maxBytes:bytes.length});
        need(existing.bytes===ref.bytes,'size_mismatch');need(existing.media_type===mediaType,'artifact_mismatch');return ref;
      }
      const existing=await request('GET','/artifacts/'+digestPath(ref.digest),{...opts,binary:true,maxBytes:bytes.length,expectedMediaType:mediaType});
      need(existing.length===ref.bytes,'size_mismatch'); need(p.digestBytes(existing)===ref.digest,'digest_mismatch');
      return ref;
    } catch(error) { if(!(error instanceof ClientError)||error.status!==404) throw error; }
    const stored=await request('PUT','/artifacts/'+digestPath(ref.digest),{...opts,body:bytes,mediaType});
    need(p.canonicalize(stored)===p.canonicalize(ref),'artifact_mismatch'); return ref;
  }
  async function verifiedResult(jobDigest,opts={}) { return (await verifiedResultWithJob(jobDigest,opts)).result; }
  async function verifiedResultWithJob(jobDigest,opts={}) {
    // The caller must retain this binding independently of the result response.
    need(opts.attempt,'attempt_required');
    const attempt=structuredClone(attemptShape(opts.attempt,jobDigest));
    const view=await getJob(jobDigest,{signal:opts.signal});
    need(view.state==='result-accepted'&&view.result_digest&&view.current_attempt,'result_unavailable');
    const accepted=attemptShape(view.current_attempt,jobDigest); need(accepted.state==='completed','stale_attempt');
    checked(p.checkAttempt(accepted,attempt)); need(accepted.holder===attempt.holder,'executor_mismatch');
    // A signed result is immutable and named by the job's result digest; a saved copy is verified again below.
    const resultKey=['result',origin,circle,view.result_digest].join('|'),saved=immutableCache?.get(resultKey);
    const envelope=saved?structuredClone(saved):await request('GET','/jobs/'+digestPath(jobDigest)+'/result',{signal:opts.signal});
    const v=await signed('result',envelope,opts.signal); checked(p.checkJobDigest(v.payload,jobDigest));
    checked(p.checkAttempt(v.payload,attempt)); checked(p.checkExecutor(v.payload,v.key_id,attempt));
    need(v.digest===view.result_digest,'result_digest_mismatch');
    if(!saved)immutableCache?.set(resultKey,structuredClone(envelope),Buffer.byteLength(JSON.stringify(envelope)));
    const job=view.job.payload, receipt=v.payload.receipt;
    need((receipt.budget_v1!==undefined)===(job.budget_v1!==undefined),'requirements_mismatch');
    need((receipt.auto_run_v1!==undefined)===(job.auto_run_v1!==undefined)&&receipt.auto_run_v1?.intent===job.auto_run_v1?.intent,'requirements_mismatch');
    // The effective selection must be one the signed request allowed; an explicit effort is never replaced.
    need((receipt.selection!==undefined)===(job.runRequest!==undefined)&&(job.runRequest===undefined||selectionSatisfies(job.runRequest,receipt.selection)),'requirements_mismatch');
    if(job.runRequest!==undefined)need(p.canonicalize(receipt.selection)===p.canonicalize(accepted.selection),'requirements_mismatch');
    need(p.canonicalize(receipt.source)===p.canonicalize(job.source),'source_mismatch');
    need(receipt.egress_applied===job.requirements.egress,'requirements_mismatch');
    need(!job.requirements.harness||job.requirements.harness.includes(receipt.harness),'requirements_mismatch');
    need(!job.requirements.model||job.requirements.model.any_of.includes(receipt.model),'requirements_mismatch');
    need(job.requirements.capabilities.every(c=>receipt.capabilities_applied.includes(c)),'requirements_mismatch');
    // The signed output answers the signed request: same kind, or none for a legacy code-change job.
    need(v.payload.output?.kind===job.result?.kind,'result_kind_mismatch');
    if(job.verify) {
      const checks=v.payload.checks;
      need(checks?.length>0,'verification_missing');
      need(checks.length===1&&checks[0].cmd===job.verify.cmd,'verification_mismatch');
    }
    const limitNames={cpu:'cpu',memory_bytes:'memory',wall_seconds:'wall',output_bytes:'output',disk_bytes:'storage'};
    for(const [k,n] of Object.entries(job.requirements.limits)) {
      need(receipt.limits_applied[k]<=n,'requirements_mismatch');
      const name=limitNames[k], unenforced=receipt.unenforced?.includes(name)===true;
      const enforced=receipt.enforced_limits?.includes(name);
      need(!(unenforced&&enforced),'requirements_mismatch');
      if(job.requirements.limit_modes?.[k]!=='preferred') need(!unenforced&&enforced!==false,'requirements_mismatch');
      else if(enforced===false) need(unenforced,'requirements_mismatch');
    }
    const outputBytes=v.payload.candidate.bytes+v.payload.transcript.bytes;
    need(outputBytes<=job.requirements.limits.output_bytes,'payload_too_large');
    need(outputBytes<=receipt.limits_applied.output_bytes&&receipt.duration_ms<=receipt.limits_applied.wall_seconds*1000,'requirements_mismatch');
    // The command binding proves which check was returned, not that the agent left its tools or tests intact.
    const command=v.payload.checks?.[0]?.cmd;
    const check_context=command===undefined?null:{independent:false,agent_mutable_workspace:true,
      note:v.payload.checks[0].skipped ? "The check didn't run, so nothing was verified." : 'Faravan ran '+command+" after the agent; the agent could change the project's test files and tools."};
    return {result:v.payload,job,check_context};
  }
  // Artifacts are content-addressed and checked against their digest, so a verified copy answers later reads of the same
  // digest without another download. The caller still reads the job first, so a deleted job's result is not served.
  async function artifact(ref,limit,signal) {
    need(ref.bytes<=limit,'payload_too_large');
    // Kept per host and circle: another circle's host may not hold, or may not admit this device to, the same bytes.
    const key=['artifact',origin,circle,ref.digest].join('|'),cached=immutableCache?.get(key);
    if(cached&&cached.length===ref.bytes)return Buffer.from(cached);
    const bytes=await request('GET','/artifacts/'+digestPath(ref.digest),{signal,binary:true,maxBytes:ref.bytes});
    need(bytes.length===ref.bytes,'size_mismatch'); need(p.digestBytes(bytes)===ref.digest,'digest_mismatch');
    immutableCache?.set(key,Buffer.from(bytes),bytes.length); return bytes;
  }
  const endAttempt = async (kind,attempt,reason,opts={}) => {
    attemptShape(attempt); need(attempt.holder===keyId,'executor_mismatch');
    need(typeof reason==='string'&&[...reason].length>0&&[...reason].length<=4096,'invalid_request');
    const result=attemptShape(await request('POST','/attempts/'+uuidPath(attempt.attempt_id)+'/'+kind,{...opts,body:{generation:attempt.generation,reason}}),attempt.job_digest);
    checked(p.checkAttempt(result,attempt)); need(result.holder===keyId,'executor_mismatch'); return result;
  };
  async function enrollment(value) {
    exact(value,['enrollment_id','state','device_key_id','roster']);
    uuidPath(value.enrollment_id); need(value.device_key_id===keyId,'device_mismatch');
    need(['pending','approved','rejected','expired'].includes(value.state));
    if(value.state==='approved') {
      const v=checked(p.verifyRoster(value.roster,{rootFingerprint:pinnedRootFingerprint,circle,now}));
      need(p.findMember(v.roster,keyId),'not_member'); await acceptRoster(value.roster);
    } else need(value.roster===null);
    return value;
  }
  async function readAttempt(attemptId,jobDigest,signal) {
    return attemptShape(await request('GET','/attempts/'+uuidPath(attemptId),{signal}),jobDigest);
  }
  const api = {
    uploadArtifact, getJob,
    async getAttempt(attempt,{signal}={}) {
      const {attempt_id,job_digest,generation}=attempt??{};
      digestPath(job_digest);
      integer(generation,1,Number.MAX_SAFE_INTEGER);
      const result=await readAttempt(attempt_id,job_digest,signal);
      checked(p.checkAttempt(result,{attempt_id,generation}));
      return result;
    },
    async accountLease(attempt,selection,{signal}={}) {
      attemptShape(attempt);need(attempt.holder===keyId,'executor_mismatch');
      const challenge=randomBuffer(24).toString('base64url');
      let result;
      try {result=await request('POST','/attempts/'+uuidPath(attempt.attempt_id)+'/account-lease',
        {signal,body:{generation:attempt.generation,selection,challenge}});}
      catch(error){if(error.status===404)throw new ClientError('host_too_old');throw error;}
      const payload=JSON.parse(result.proof.signedEnvelope).payload;
      const roster=await current(signal);
      need(payload.challenge===challenge&&result.binding.circle===circle&&result.binding.holder===keyId&&
        result.binding.jobId===attempt.job_digest&&result.binding.attemptId===attempt.attempt_id&&
        result.binding.fence===attempt.generation&&result.binding.membershipEpoch===roster.epoch&&
        p.canonicalize(result.binding.selection)===p.canonicalize(selection),'lease_fenced');
      checked(verifyLease(result.proof,result.publicKey,result.binding,now()*1000));
      return result;
    },
    async verifyAccountLease({proof,selection,jobId,attemptId,nowMs,signal}) {
      try {
        const attempt=await readAttempt(attemptId,undefined,signal);
        // The fetched attempt is the coordinator's own answer about this lease: a wrong job is a fence.
        if(attempt.job_digest!==jobId)return {ok:false,error:{code:'lease_fenced',status:403,retryAtMs:null}};
        const current=await api.accountLease(attempt,selection,{signal});
        return verifyLease(proof,current.publicKey,current.binding,nowMs);
      }catch(error){return {ok:false,error:{code:error.code??'authority_unavailable',
        // The answer class travels with the refusal: an HTTP 4xx problem is the coordinator judging
        // the lease; transport failures, timeouts and 5xx/429 carry no status or an unavailable one.
        status:Number.isInteger(error.status)?error.status:null,retryAtMs:null}};}
    },
    signContinuation:(handoff,binding)=>signHandoff(handoff,{...binding,circle},privateKey),
    // Public identity only; device private key material never leaves the client.
    async resultContext({signal}={}) { return {circle, keyId, roster_epoch:(await current(signal)).epoch}; },
    async fetchArtifact(ref,{signal}={}) {
      need(ref && Number.isSafeInteger(ref.bytes) && ref.bytes >= 0,'invalid_request');
      digestPath(ref.digest);
      return artifact(ref,maxArtifactBytes,signal);
    },
    async stopped(attempt,{stoppedAt=new Date(now()*1000).toISOString().replace('.000Z','Z'),...opts}={}) {
      attemptShape(attempt); need(attempt.holder===keyId,'executor_mismatch');
      const result=attemptShape(await request('POST','/attempts/'+uuidPath(attempt.attempt_id)+'/stopped',
        {...opts,body:{generation:attempt.generation,stopped_at:stoppedAt}}),attempt.job_digest);
      checked(p.checkAttempt(result,attempt)); need(result.holder===keyId&&result.compute_stopped===true,'invalid_response');
      return result;
    },
    async requestStop(attempt,opts={}) {
      attemptShape(attempt);need(attempt.holder===keyId,'executor_mismatch');
      const host=await capabilities({signal:opts.signal});
      need(host.capabilities.includes('stop_intent_v1'),'host_too_old');
      const result=await request('POST','/attempts/'+uuidPath(attempt.attempt_id)+'/stop-request',
        {...opts,body:{generation:attempt.generation}});
      return structuredClone(stopRequestShape(result,attempt));
    },
    async getStopRequest(attempt,{signal}={}) {
      attemptShape(attempt);
      let host;
      try {host=await capabilities({signal});}
      catch(error) {if(error.status===404)return null;throw error;}
      if(!host.capabilities.includes('stop_intent_v1'))return null;
      const result=await request('GET','/attempts/'+uuidPath(attempt.attempt_id)+'/stop-request',{signal});
      return result===null?null:structuredClone(stopRequestShape(result,attempt));
    },
    async submitJob(payload,{idempotencyKey,signal}={}) {
      // P22: a field an older host would refuse is sent only to a host that says it understands it.
      const needs=hostCapabilitiesFor(payload);
      if(needs.length){const host=await capabilities({signal});for(const name of needs)need(host.capabilities.includes(name),'host_too_old');}
      const roster=await current(); need(payload.circle===circle,'wrong_circle');
      need(payload.author===keyId,'author_mismatch'); need(payload.roster_epoch===roster.epoch,'roster_stale');
      const envelope=p.signEnvelope('job',payload,privateKey), jobDigest=p.digest(payload), key=operationKey(idempotencyKey);
      const view=await request('POST','/jobs',{body:envelope,idempotencyKey:key,signal,personAction:true});
      try {await verifyJobView(view,jobDigest,signal);}
      catch(cause) {
        throw new ClientError(cause?.code??'invalid_response',{status:cause?.status??0,retryable:true,
          problem:cause?.problem??null,outcome:'unknown',cause,operationKey:key});
      }
      return {jobDigest,operationKey:key};
    },
    async *listJobs({limit=50,cursor,signal}={}) {
      integer(limit,1,100); const seen=new Set();
      for(;;) {
        abort(signal); need(cursor===undefined||cursor===null||typeof cursor==='string'&&cursor.length<=2048,'invalid_request');
        const query=new URLSearchParams({limit:String(limit)}); if(cursor) query.set('cursor',cursor);
        // Say which job generations this client can read; a coordinator that predates the header ignores it.
        const page=await request('GET','/jobs?'+query,{signal,headers:{'Faravan-Client-Capabilities':LIST_CAPABILITIES.join(',')}});
        exact(page,['items','next_cursor']); need(Array.isArray(page.items)&&page.items.length<=limit);
        need(page.next_cursor===null||typeof page.next_cursor==='string'&&page.next_cursor.length>0&&page.next_cursor.length<=2048);
        for(const item of page.items) yield await verifyJobView(item,undefined,signal);
        if(page.next_cursor===null) return;
        need(!seen.has(page.next_cursor),'cursor_cycle'); seen.add(page.next_cursor); cursor=page.next_cursor;
      }
    },
    async waitForJobChange(jobDigest,{after,signal,waitSeconds=30}={}) {
      digestPath(jobDigest);
      need(after===null||DIGEST.test(after),'invalid_request');
      integer(waitSeconds,1,30);
      const query=new URLSearchParams({wait:String(waitSeconds)});if(after)query.set('after',after);
      const result=await request('GET','/jobs/'+digestPath(jobDigest)+'/watch?'+query,{signal});
      exact(result,['revision']);need(DIGEST.test(result.revision),'invalid_response');
      return result;
    },
    /** Queued jobs (oldest queued first), each a verified JobView plus the host's `published_at`. Needs host `offers_v1`
     *  (else ClientError 'host_too_old'; fall back to listJobs). The first page holds up to waitSeconds: while the list is empty,
     *  or, with `since` (a previous revision), until the open set changes. onRevision(n) receives the revision to pass next time. */
    async *listOffers({limit=100,waitSeconds=30,since,signal,onRevision}={}) {
      integer(limit,1,100); integer(waitSeconds,0,30); if(since!==undefined) integer(since,0,Number.MAX_SAFE_INTEGER);
      const host=await capabilities({signal}); need(host.capabilities.includes('offers_v1'),'host_too_old');
      const seen=new Set(); let cursor;
      for(;;) {
        abort(signal);
        const query=new URLSearchParams({limit:String(limit)});
        if(cursor) query.set('cursor',cursor);
        else {if(waitSeconds>0) query.set('wait',String(waitSeconds)); if(since!==undefined) query.set('since',String(since));}
        const page=await request('GET','/offers?'+query,{signal,headers:{'Faravan-Client-Capabilities':LIST_CAPABILITIES.join(',')}});
        exact(page,['items','next_cursor','revision']); need(Array.isArray(page.items)&&page.items.length<=limit);
        need(page.next_cursor===null||typeof page.next_cursor==='string'&&page.next_cursor.length>0&&page.next_cursor.length<=2048);
        integer(page.revision,0,Number.MAX_SAFE_INTEGER); if(!cursor) onRevision?.(page.revision);
        for(const {published_at,...item} of page.items) {
          timestamp(published_at); need(item.state==='queued','invalid_response');
          yield {...await verifyJobView(item,undefined,signal),published_at};
        }
        if(page.next_cursor===null) return;
        need(!seen.has(page.next_cursor),'cursor_cycle'); seen.add(page.next_cursor); cursor=page.next_cursor;
      }
    },
    async waitForJob(jobDigest,{signal,timeoutMs=300000,pollMs=1000}={}) {
      integer(timeoutMs,1,2147483647); integer(pollMs,1,60000);
      const timeout=new AbortController(), combined=signal?AbortSignal.any([signal,timeout.signal]):timeout.signal;
      const timer=setTimeout(()=>timeout.abort(new ClientError('timeout',{outcome:'unknown'})),timeoutMs);
      try { for(;;) { const view=await getJob(jobDigest,{signal:combined}); if(TERMINAL.has(view.state)) return view; await sleep(pollMs,combined); } }
      finally { clearTimeout(timer); }
    },
    async cancelJob(jobDigest,{reason='cancelled',payload,...opts}={}) {
      const roster=await current();
      if(payload) { need(payload.circle===circle,'wrong_circle'); need(payload.author===keyId,'author_mismatch'); need(payload.job_digest===jobDigest,'wrong_job_digest'); need(payload.roster_epoch<=roster.epoch,'roster_stale'); }
      const envelope=p.signEnvelope('cancellation',payload??{schema:'faravan.cancellation.v1',circle,job_digest:jobDigest,author:keyId,
        roster_epoch:roster.epoch,created_at:new Date(now()*1000).toISOString().replace('.000Z','Z'),reason},privateKey);
      const ack=await request('POST','/jobs/'+digestPath(jobDigest)+'/cancel',{...opts,body:envelope,personAction:true});
      exact(ack,['job_digest','cancellation_digest','requested_at','authority_revoked','compute_stopped','attempt']);
      need(ack.job_digest===jobDigest&&ack.cancellation_digest===p.digest(envelope.payload)&&ack.authority_revoked===true&&typeof ack.compute_stopped==='boolean');
      if(ack.attempt) attemptShape(ack.attempt,jobDigest); return ack;
    },
    // P17a: when the host deletes a job, and delete a finished one now (its author or the owner device). Hosts without retention_v1 refuse locally.
    async jobRetention(jobDigest,opts={}) {
      const host=await capabilities({signal:opts.signal});need(host.capabilities.includes('retention_v1'),'host_too_old');
      const info=await request('GET','/jobs/'+digestPath(jobDigest)+'/retention',opts);
      exact(info,['job_digest','state','ended_at','retained_until','deletable']);
      need(info.job_digest===jobDigest&&typeof info.state==='string'&&typeof info.deletable==='boolean');
      for(const key of ['ended_at','retained_until'])need(info[key]===null||Number.isFinite(Date.parse(info[key])),'invalid_response');
      return info;
    },
    async deleteJob(jobDigest,{idempotencyKey,...opts}={}) {
      const key=operationKey(idempotencyKey),deleteOutcome={dispatched:false,refused:false,uncertain:false};
      try {
        const host=await capabilities({signal:opts.signal});need(host.capabilities.includes('retention_v1'),'host_too_old');
        const ack=await request('POST','/jobs/'+digestPath(jobDigest)+'/delete',{...opts,body:{},idempotencyKey:key,personAction:true,deleteOutcome});
        exact(ack,['job_digest','deleted','at']);need(ack.job_digest===jobDigest&&ack.deleted===true,'invalid_response');
        return ack;
      } catch(cause) {
        // Parsing, ACK validation and retry/preflight failures share one delete authority.
        // Nothing after dispatch is a safe refusal unless every dispatched attempt was refused.
        if(deleteOutcome.uncertain||deleteOutcome.dispatched&&!deleteOutcome.refused) {
          if(cause instanceof ClientError&&cause.outcome==='unknown'&&cause.operationKey===key)throw cause;
          throw unknownDelete(cause,key);
        }
        throw cause;
      }
    },
    async fetchReceipt(jobDigest,opts={}) {
      const {result,check_context}=await verifiedResultWithJob(jobDigest,opts);
      return {receipt:structuredClone(result.receipt),checks:structuredClone(result.checks??[]),
        ...(result.output?{output:structuredClone(result.output)}:{}),...(check_context?{check_context}:{})};
    },
    async fetchResult(jobDigest,opts={}) {
      const {result,job,check_context}=await verifiedResultWithJob(jobDigest,opts);
      const bytes=await artifact(result.candidate,maxArtifactBytes,opts.signal);
      await artifact(result.transcript,maxTranscriptBytes,opts.signal);
      return opts.includeMetadata ? {bytes,candidate:structuredClone(result.candidate),receipt:structuredClone(result.receipt),
        ...(result.checks?{checks:structuredClone(result.checks)}:{}),...(result.output?{output:structuredClone(result.output)}:{}),
        ...(check_context?{check_context}:{}),job:structuredClone(job)} : bytes;
    },
    async fetchTranscript(jobDigest,opts={}) {
      const result=await verifiedResult(jobDigest,opts); return artifact(result.transcript,maxTranscriptBytes,opts.signal);
    },
    async claimNext(capabilities,{signal,leaseSeconds=120,waitSeconds=30,idempotencyKey,exclude}={}) {
      integer(leaseSeconds,30,300); integer(waitSeconds,0,30);
      if(exclude!==undefined)need(Array.isArray(exclude)&&exclude.length<=64&&exclude.every(id=>typeof id==='string'&&DIGEST.test(id)),'invalid_request');
      let claim;
      try {
        claim=await request('POST','/jobs/claim-next',{signal,idempotencyKey,
          body:{advertisement:capabilities,lease_seconds:leaseSeconds,wait_seconds:waitSeconds,...(exclude===undefined?{}:{exclude})}});
      } catch(error) {
        if(error instanceof ClientError&&error.responseReceived) error.claimRejected=true;
        throw error;
      }
      if(claim===null) return null;
      return acceptClaim(claim,capabilities,signal);
    },
    /** Named claim of one offered job (POST /jobs/{digest}/claim): the same verified {job_digest,job,attempt} as claimNext. Exactly one claimant wins; the rest get ClientError 'conflict'. */
    async claimJob(jobDigest,capabilities,{signal,leaseSeconds=120,idempotencyKey}={}) {
      integer(leaseSeconds,30,300);
      let claim;
      try {
        claim=await request('POST','/jobs/'+digestPath(jobDigest)+'/claim',{signal,idempotencyKey,
          body:{advertisement:capabilities,lease_seconds:leaseSeconds}});
      } catch(error) {
        if(error instanceof ClientError&&error.responseReceived) error.claimRejected=true;
        throw error;
      }
      return acceptClaim(claim,capabilities,signal,jobDigest);
    },
    async declineJob(jobDigest,{idempotencyKey,...opts}={}) {
      const host=await capabilities({signal:opts.signal});need(host.capabilities.includes('offer_decline_v1'),'host_too_old');
      const ack=await request('POST','/jobs/'+digestPath(jobDigest)+'/decline',
        {...opts,body:{},idempotencyKey:operationKey(idempotencyKey),personAction:true});
      exact(ack,['job_digest','declined']);need(ack.job_digest===jobDigest&&typeof ack.declined==='boolean','invalid_response');
      return ack;
    },
    async startAttempt(attempt,opts={}) {
      attemptShape(attempt);need(attempt.holder===keyId,'executor_mismatch');
      const result=attemptShape(await request('POST','/attempts/'+uuidPath(attempt.attempt_id)+'/start',
        {...opts,body:{generation:attempt.generation}}),attempt.job_digest);
      checked(p.checkAttempt(result,attempt));need(result.holder===keyId&&result.execution_started_at!==null,'invalid_response');
      // An idempotent start acknowledgement alone cannot revive a released or expired lease.
      const latest=await readAttempt(attempt.attempt_id,attempt.job_digest,opts.signal);
      checked(p.checkAttempt(latest,attempt));need(latest.holder===keyId&&latest.execution_started_at===result.execution_started_at,'invalid_response');
      need(latest.state==='active'&&Date.parse(latest.lease_expires_at)>now()*1000,'lease_expired');
      return latest;
    },
    async observeExecutionStart(attempt,opts={}) {
      attemptShape(attempt);need(attempt.holder===keyId,'executor_mismatch');
      const {requireLaunchAuthority=false,...requestOptions}=opts;
      try {
        const {observation,...reply}=await request('POST','/attempts/'+uuidPath(attempt.attempt_id)+'/observed-start',
          {...requestOptions,body:{generation:attempt.generation,...(opts.observedAt===undefined?{}:{observed_at:opts.observedAt})}});
        const result=attemptShape(reply,attempt.job_digest);
        checked(p.checkAttempt(result,attempt));
        need(result.holder===keyId,'invalid_response');
        // A stopped attempt whose job moved to a newer attempt: the coordinator records no observation for it. This is a
        // terminal answer, not proof that the agent ran, and it is never a success with a time.
        if(observation==='superseded') {
          need(result.compute_stopped===true&&result.execution_observed_at==null,'invalid_response');
          return {...result,observation};
        }
        need(observation===undefined&&typeof result.execution_observed_at==='string','invalid_response');
        if(requireLaunchAuthority) {
          // POST retries can replay history from before cancellation. Read current authority only after that reply.
          const latest=await readAttempt(attempt.attempt_id,attempt.job_digest,opts.signal);
          checked(p.checkAttempt(latest,attempt));
          need(latest.holder===keyId&&latest.execution_observed_at===result.execution_observed_at,'invalid_response');
          return latest;
        }
        return result;
      } catch(error) {
        if(!(error instanceof ClientError&&error.status===404))throw error;
        // Older coordinators have no observed-start route. A coordinator that lost the attempt answers the same 404
        // not_found, so probe GET /attempts/<id> (every coordinator serves it): a known attempt means only the route is
        // missing. A failed probe is rethrown, never read as an older coordinator. The local backend callback remains
        // evidence for this host's own projection.
        const probe=await request('GET','/attempts/'+uuidPath(attempt.attempt_id),{signal:opts.signal});
        if(requireLaunchAuthority) {
          let latest=attemptShape(probe,attempt.job_digest);
          checked(p.checkAttempt(latest,attempt));
          need(latest.holder===keyId,'invalid_response');
          need(latest.state==='active'&&!latest.compute_stopped,'lease_expired');
          if(Date.parse(latest.lease_expires_at)<=now()*1000) {
            // A delayed probe can predate a successful renewal. Recheck authority before denying expiry.
            latest=attemptShape(await request('GET','/attempts/'+uuidPath(attempt.attempt_id),{signal:opts.signal}),attempt.job_digest);
            checked(p.checkAttempt(latest,attempt));
            need(latest.holder===keyId,'invalid_response');
            need(latest.state==='active'&&!latest.compute_stopped,'lease_expired');
          }
          need(Date.parse(latest.lease_expires_at)>now()*1000,'lease_expired');
        }
        return null;
      }
    },
    async renew(attempt,{leaseSeconds=120,...opts}={}) {
      attemptShape(attempt); need(attempt.holder===keyId,'executor_mismatch'); integer(leaseSeconds,30,300);
      const result=attemptShape(await request('POST','/attempts/'+uuidPath(attempt.attempt_id)+'/renew',{...opts,body:{generation:attempt.generation,lease_seconds:leaseSeconds}}),attempt.job_digest);
      checked(p.checkAttempt(result,attempt)); need(result.holder===keyId,'executor_mismatch');
      need(result.state==='active'&&Date.parse(result.lease_expires_at)>now()*1000,'lease_expired'); return result;
    },
    // P1b: a lender reports its state every 30 s; any member reads who is online and able.
    async heartbeat(body,opts={}) {
      if(body.agents?.some(agent=>Object.hasOwn(agent,'model_efforts')||Object.hasOwn(agent,'auto_run_intents')) || body.capabilities?.includes(MODEL_EFFORT_PAIRS_CAPABILITY) || Object.hasOwn(body,'accounts')) {
        let host;
        try { host=await capabilities({signal:opts.signal}); }
        catch(error) { if(error.status!==404)throw error; host={capabilities:[]}; }
        if(!host.capabilities.includes(MODEL_EFFORT_PAIRS_CAPABILITY)) {
          body={...body,...(Array.isArray(body.agents)?{agents:body.agents.map(({model_efforts,...agent})=>agent)}:{}),
            ...(Array.isArray(body.capabilities)?{capabilities:body.capabilities.filter(cap=>cap!==MODEL_EFFORT_PAIRS_CAPABILITY)}: {})};
        }
        // A host without the run request capability has a closed heartbeat shape: it is not sent accounts it cannot read.
        if(!host.capabilities.includes(RUN_REQUEST_CAPABILITY)) {
          const {accounts,...rest}=body;
          body={...rest,...(Array.isArray(body.capabilities)?{capabilities:body.capabilities.filter(cap=>cap!==RUN_REQUEST_CAPABILITY)}:{})};
        }
        // A host that predates the automatic choice has a closed agent shape: it must not be sent which choices a lender can make.
        if(!host.capabilities.includes(AUTO_RUN_CAPABILITY)) {
          body={...body,...(Array.isArray(body.agents)?{agents:body.agents.map(({auto_run_intents,...agent})=>agent)}:{}),
            ...(Array.isArray(body.capabilities)?{capabilities:body.capabilities.filter(cap=>cap!==AUTO_RUN_CAPABILITY)}: {})};
        }
      }
      const ack=await request('POST','/heartbeat',{...opts,body});
      exact(ack,['received_at','online_seconds']);timestamp(ack.received_at);return ack;
    },
    async fetchPresence(opts={}) {
      const page=await request('GET','/presence',opts);
      exact(page,['now','online_seconds','devices','persons']);
      need(Array.isArray(page.devices)&&Array.isArray(page.persons)&&page.devices.length<=1024);
      return page;
    },
    async postLiveTranscript(attempt,{seq,text,truncated,...opts}={}) {
      attemptShape(attempt);need(attempt.holder===keyId,'executor_mismatch');
      need(Number.isSafeInteger(seq)&&seq>0&&typeof text==='string'&&typeof truncated==='boolean','invalid_request');
      const body={attempt:attempt.attempt_id,seq,text,truncated};
      need(Buffer.byteLength(text)<=TRANSCRIPT_RELAY_LIMITS.snapshotBytes,'payload_too_large');
      let bytes;try{bytes=Buffer.byteLength(p.canonicalize(body));}catch{throw new ClientError('invalid_request');}
      need(bytes<=TRANSCRIPT_RELAY_LIMITS.requestBytes,'payload_too_large');
      await requireTranscriptRelay(opts.signal);
      const ack=await request('POST','/jobs/'+digestPath(attempt.job_digest)+'/transcript',{...opts,body});
      exact(ack,['job_digest','attempt','seq','at']);
      need(ack.job_digest===attempt.job_digest&&ack.attempt===attempt.attempt_id&&ack.seq===seq);timestamp(ack.at);
      return ack;
    },
    async fetchLiveTranscript(jobDigest,opts={}) {
      const path='/jobs/'+digestPath(jobDigest)+'/transcript';
      await requireTranscriptRelay(opts.signal);
      const snapshot=await request('GET',path,opts);
      exact(snapshot,['job_digest','attempt','seq','at','text','truncated','available']);
      need(snapshot.job_digest===jobDigest&&typeof snapshot.text==='string'&&typeof snapshot.truncated==='boolean'&&
        typeof snapshot.available==='boolean');
      need(snapshot.attempt===null||typeof snapshot.attempt==='string'&&UUID.test(snapshot.attempt));
      need(Buffer.byteLength(snapshot.text)<=TRANSCRIPT_RELAY_LIMITS.snapshotBytes,'payload_too_large');
      need(Number.isSafeInteger(snapshot.seq)&&snapshot.seq>=0);
      if(snapshot.seq>0) {
        need(snapshot.available&&snapshot.attempt!==null);timestamp(snapshot.at);
      } else need(snapshot.at===null&&snapshot.text===''&&snapshot.truncated===false);
      need(snapshot.attempt!==null||!snapshot.available);
      return snapshot;
    },
    // Optional progress channel. The lender posts coarse steps; the author and lenders read them.
    // A stage entry ({stage, elapsed_s}, P8b) and an action step ({step, kind}) are separate variants.
    async postProgress(attempt,{step,kind='step',stage,elapsed_s,...opts}={}) {
      attemptShape(attempt);need(attempt.holder===keyId,'executor_mismatch');
      const body=stage!==undefined?{attempt:attempt.attempt_id,stage,elapsed_s}:{attempt:attempt.attempt_id,step,kind};
      const entry=await request('POST','/jobs/'+digestPath(attempt.job_digest)+'/progress',{...opts,body});
      progressEntry(entry,attempt.job_digest);return entry;
    },
    async fetchProgress(jobDigest,{after=0,...opts}={}) {
      integer(after,0,999999999);
      const page=await request('GET','/jobs/'+digestPath(jobDigest)+'/progress'+(after?'?after='+after:''),opts);
      exact(page,['job_digest','entries','next_after']);
      need(page.job_digest===jobDigest&&Array.isArray(page.entries)&&page.entries.length<=160);
      for(const entry of page.entries)progressEntry(entry,jobDigest);
      integer(page.next_after,0,Number.MAX_SAFE_INTEGER);return page;
    },
    release:(attempt,reason='released',opts={})=>endAttempt('release',attempt,reason,opts),
    fail:(attempt,reason,opts={})=>endAttempt('fail',attempt,reason,opts),
    // `job` binds the upload to the job it delivers: the host keeps the files until that job has delivered, and refuses them once it cannot.
    async uploadResultArtifacts({candidate,transcript,job,candidateMediaType='text/x-diff',transcriptMediaType='application/x-ndjson'},opts={}) {
      need(transcript.byteLength<=maxTranscriptBytes,'payload_too_large');
      if(job!==undefined)opts={...opts,headers:{...opts.headers,'Faravan-Job':digestPath(job)}};
      const upload=(bytes,mediaType)=>opts.withArtifactRequest
        ? opts.withArtifactRequest(signal=>uploadArtifact(bytes,mediaType,{...opts,signal}))
        : uploadArtifact(bytes,mediaType,opts);
      return {
        candidate:await upload(candidate,candidateMediaType),
        transcript:await upload(transcript,transcriptMediaType),
      };
    },
    async completeAttempt(attempt,payload,opts={}) {
      attemptShape(attempt); checked(p.checkAttempt(payload,attempt)); checked(p.checkJobDigest(payload,attempt.job_digest));
      checked(p.checkExecutor(payload,keyId,attempt)); checked(p.checkCircle(payload,circle));
      need(payload.roster_epoch<=(await current(opts.signal)).epoch,'roster_stale');
      need(p.findMember((await rosterAt(payload.roster_epoch,opts.signal)).roster,keyId),'not_member');
      const envelope=p.signEnvelope('result',payload,privateKey);
      const ack=await request('POST','/attempts/'+uuidPath(attempt.attempt_id)+'/complete',{...opts,body:envelope});
      try {
        exact(ack,['job_digest','result_digest','attempt_id','generation','accepted_at','status']);
        need(ack.status==='result-accepted'&&ack.result_digest===p.digest(payload)&&ack.job_digest===attempt.job_digest,'invalid_response');
        checked(p.checkAttempt(ack,attempt)); return ack;
      } catch (cause) {
        throw new ClientError('invalid_response',{cause,retryable:true,outcome:'unknown',responseReceived:true,operationKey:opts.idempotencyKey});
      }
    },
    // Bootstrap must keep the original closed proof schema. Names are published only after membership.
    async enroll(link,{deviceName,personName,allowExpiredInvite=false,...opts}={}) {
      const decoded=checked(p.decodeInviteLink(link));
      need(typeof allowExpiredInvite==='boolean','invalid_request');
      const expiresAt=Date.parse(decoded.invite.payload.expires_at),expiresSecond=Math.floor(expiresAt/1000);
      const verifyNow=allowExpiredInvite&&Number.isFinite(expiresAt)&&now()>=expiresSecond?()=>expiresSecond-1:now;
      checked(p.verifyInvite(decoded.invite,{rootFingerprint:pinnedRootFingerprint,circle,coordinator:origin,now:verifyNow,lanMode}));
      const proof=p.createEnrollmentProof({circle,invite_id:decoded.invite.payload.invite_id,device_public_key:publicKey,...(deviceName===undefined?{}:{device_name:deviceName})},p.privateKeyFromSeed(decoded.invite_private_seed));
      const response=await request('POST','/enrollments',{...opts,bootstrap:true,
        body:{invite:decoded.invite,device_public_key:publicKey,enrollment_proof:proof}});
      try { return await enrollment(response); }
      catch(error) {
        error.responseReceived=true;error.outcome='unknown';
        throw error;
      }
    },
    async getEnrollment(id,opts={}) { return enrollment(await request('GET','/enrollments/'+uuidPath(id),{...opts,bootstrap:true})); },
    /** Ask the owner to remove this device from the roster (optional; an older coordinator answers not_found). */
    async requestLeave(opts={}) {
      const issued=new Date(now()*1000).toISOString().replace('.000Z','Z');
      const envelope=p.signEnvelope('leave',{schema:'faravan.leave.v1',circle,key_id:keyId,issued_at:issued},privateKey);
      const result=await request('POST','/leave-requests',{...opts,body:{leave:envelope}});
      exact(result,['leave_id','key_id','state','created_at']);
      need(result.key_id===keyId&&result.state==='pending'&&Number.isFinite(Date.parse(result.created_at)),'invalid_response');
      uuidPath(result.leave_id);return result;
    },
    /** Pending leave requests of current members. The caller verifies each signature; the coordinator's word is not enough. */
    async listLeaveRequests(opts={}) {
      const page=await request('GET','/leave-requests',opts);
      exact(page,['items']);need(Array.isArray(page.items)&&page.items.length<=100,'invalid_response');
      for(const item of page.items){
        exact(item,['leave_id','key_id','state','created_at','leave']);uuidPath(item.leave_id);
        need(item.state==='pending'&&Number.isFinite(Date.parse(item.created_at)),'invalid_response');
      }
      return page.items;
    },
    /** Offer this member's own serving origin to the circle's publishers. Reach data only; nothing changes until an
     *  authorized publisher signs it into a roster. The sender is this device, named by the request proof. */
    async proposeMemberOrigin(proposal,opts={}) {
      const result=await request('POST','/member-origins',{...opts,body:{proposal}});
      exact(result,['key_id','state','proposal_digest','created_at']);
      need(result.key_id===keyId&&['proposed','withdrawn'].includes(result.state)&&result.proposal_digest===p.digest(proposal)&&Number.isFinite(Date.parse(result.created_at)),'invalid_response');
      return result;
    },
    /** Current member origin claims, for an owner, steward or co-admin. Each carries the member's request proof; the
     *  caller verifies it against its own roster, never the coordinator's summary. */
    async listMemberOrigins(opts={}) {
      const page=await request('GET','/member-origins',opts);
      exact(page,['items']);need(Array.isArray(page.items)&&page.items.length<=100,'invalid_response');
      for(const item of page.items){
        exact(item,['key_id','state','proposal_digest','created_at','proposal','proof']);
        need(typeof item.proof==='string'&&Number.isFinite(Date.parse(item.created_at)),'invalid_response');
      }
      return page.items;
    },
    capabilities,hostSupports,
    async refreshRoster(opts={}) { const envelope=await request('GET','/roster',{...opts,refresh:true}); return acceptRoster(envelope,{fetchedAtMs:clock()*1000}); },
    async publishRoster(envelope,opts={}) {
      await load();
      const v=checked(p.verifyRoster(envelope,{rootFingerprint:pinnedRootFingerprint,circle,now,
        highestAcceptedEpoch:state.highestAcceptedEpoch??0,highestAcceptedDigest:state.highestAcceptedDigest,previousAuthorityChain:state.current?.payload.authority_chain,previousRoster:state.current?.payload}));
      checkTransport(v.roster);need(p.findMember(v.roster,keyId),'not_member');
      const stored=await request('PUT','/roster',{...opts,body:envelope,proposedEpoch:v.roster.epoch});
      need(p.canonicalize(stored)===p.canonicalize(envelope),'roster_mismatch');
      return acceptRoster(stored);
    },
    async revokeInvite(body,opts={}) {
      await capabilities(opts);
      need(hostSupports('invite_revoke_v1'),'host_update_required');
      const stored=await request('POST','/invites/revoke',{...opts,body});
      need(stored.invite_id===body.invite_id&&stored.revoked===true,'invalid_response');
      return stored;
    },
    async rejectEnrollment(body,opts={}) {
      await capabilities(opts);
      need(hostSupports('enrollment_reject_v1'),'host_update_required');
      const stored=await request('POST','/enrollments/reject',{...opts,body});
      exact(stored,['enrollment_id','state','device_key_id','roster']);
      need(stored.enrollment_id===body.enrollment_id&&['rejected','expired','approved'].includes(stored.state),'invalid_response');
      return stored;
    },
    async registerInvite(invite,opts={}) {
      checked(p.verifyInvite(invite,{rootFingerprint:pinnedRootFingerprint,circle,coordinator:origin,now,lanMode}));
      const stored=await request('POST','/invites',{...opts,body:invite});
      need(p.canonicalize(stored)===p.canonicalize(invite),'invite_mismatch');
      return stored;
    },
    /** Publish an invite under a short code. `binding` is the invite key's signature over the exact envelope. */
    async publishInvite({code,invite,binding},opts={}) {
      checked(p.verifyInvite(invite,{rootFingerprint:pinnedRootFingerprint,circle,coordinator:origin,now,lanMode}));
      checked(p.verifyInviteBinding(invite,binding,{invitePublicKey:invite.payload.invite_public_key}));
      need(p.INVITE_CODE_PATTERN.test(code),'invalid_request');
      const body={code,envelope:invite,invite_binding:binding};
      const stored=await request('POST','/invites',{...opts,body});
      need(p.canonicalize(stored)===p.canonicalize(body),'invite_mismatch');
      return stored;
    },
    async *listEnrollments({state='pending',limit=50,cursor,signal}={}) {
      integer(limit,1,100); need(['pending','rejected'].includes(state),'invalid_request'); const seen=new Set();
      for(;;) {
        need(cursor===undefined||typeof cursor==='string'&&cursor.length<=2048,'invalid_request');
        const query=new URLSearchParams({state,limit:String(limit)});
        if(cursor) query.set('cursor',cursor);
        const page=await request('GET','/enrollments?'+query,{signal});
        exact(page,['items','next_cursor']); need(Array.isArray(page.items)&&page.items.length<=limit);
        need(page.next_cursor===null||typeof page.next_cursor==='string'&&page.next_cursor.length>0&&page.next_cursor.length<=2048);
        for(const item of page.items) {
          exact(item,['enrollment_id','state','invite_id','device_public_key','enrollment_proof','created_at']);
          uuidPath(item.enrollment_id); uuidPath(item.invite_id); p.importPublicKey(item.device_public_key);
          need(['pending','approved','rejected','expired'].includes(item.state)&&Number.isFinite(Date.parse(item.created_at)));
          yield item;
        }
        if(page.next_cursor===null) return;
        need(!seen.has(page.next_cursor),'cursor_cycle'); seen.add(page.next_cursor); cursor=page.next_cursor;
      }
    },
  };
  const normalize = error => error instanceof p.ProtocolError ? new ClientError(error.code,{cause:error}) : error;
  for (const [name,method] of Object.entries(api)) {
    if (name === 'listJobs' || name === 'listEnrollments' || name === 'listOffers') {
      api[name] = async function* (...args) {
        try { yield* method(...args); } catch(error) { throw normalize(error); }
      };
    } else {
      api[name] = async (...args) => {
        try { return await method(...args); } catch(error) { throw normalize(error); }
      };
    }
  }
  return api;
}

/** At most `width` holders at once; the rest wait in order. Resolves to a release function that is safe to call twice. */
export function createSlots(width) {
  let active=0;const waiting=[];
  const grant=()=>{active++;let done=false;return ()=>{if(done)return;done=true;active--;waiting.shift()?.();};};
  return signal=>new Promise((resolve,reject)=>{
    if(signal?.aborted)return reject(signal.reason??new DOMException('Aborted','AbortError'));
    if(active<width)return resolve(grant());
    const turn=()=>{signal?.removeEventListener('abort',cancel);resolve(grant());};
    const cancel=()=>{const at=waiting.indexOf(turn);if(at>=0)waiting.splice(at,1);reject(signal.reason??new DOMException('Aborted','AbortError'));};
    signal?.addEventListener('abort',cancel,{once:true});waiting.push(turn);
  });
}

// HTTP refusals override problem codes; local failures have no explicit HTTP retry flag.
export function clientFailure(error) {
  const status=Number.isInteger(error?.status)?error.status:0;
  const refused=status>=400&&status<500&&status!==429&&error?.retryable===false;
  const transient=error?.retryable===true||status===429||status>=500;
  // Keep an absent HTTP flag absent: a local update hold can also use status 409.
  const retryable=refused?false:transient?true:error?.retryable;
  const code=retryable?'network_error':typeof error?.code==='string'&&/^[a-z][a-z0-9_]{0,63}$/.test(error.code)?error.code:'operation_failed';
  const response = receivedResponse(error?.receivedResponse);
  return {code,status,retryable,...(response ? {receivedResponse: response} : {})};
}
