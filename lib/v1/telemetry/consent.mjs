// Consent: what may be captured and uploaded now, and under which pseudonym. One module, because a consent change and an
// identity change always happen together (design §2.2). The policy file is the only record of a choice.
//
//   <dir>/policy.json  {version:2, level:on|off|null, region, noticeShownAt, decidedAt, generation}   0600, atomic
//   <dir>/install.json {id: random UUID} (shared install identity)
//   <dir>/state.json   {epoch:{id, startedAt}} (local catalog correlation only)                                              0600, atomic
//
// Every policy write raises `generation`. A record uploads only under the generation it was captured in, so nothing
// captured under one consent can upload under another (docs/design/TELEMETRY-WIRE.md §9). Nothing here touches the
// outbox or the rollup: each mutator returns {before, after}, and the facade applies the transition to them.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import { join } from 'node:path';
import { syncDirectory } from '../../durable-directory.mjs';
import { saveJsonFile } from '../../local-state.mjs';
import { acquireProcessLockSync } from '../lock.mjs';
import { randomId, installUuid } from './ids.mjs';
import {TELEMETRY_ENABLED} from './contract.mjs';
import { envSwitch } from './switch.mjs';
import {readRemoteLease,REMOTE_LEASE_FILE} from './remote-lease.mjs';
import { isGeneration } from './catalog.mjs';

export { envSwitch };

export const LEVELS = Object.freeze(['off', 'on']);
export const STREAMS_BY_LEVEL = Object.freeze({off: [], on: ['counts', 'quota', 'diagnostics']});
const DAY_MS = 86400000;
const LOCK_WAIT_MS = 2000;

export const isRegionCode = value => typeof value === 'string' && /^[A-Z]{2}$/.test(value);
/** Launch policy: ON after the notice, regardless of the legacy local region field. */
export const regionDefault = () => 'on';

const EMPTY_POLICY = Object.freeze({version: 2, level: null, region: null, noticeShownAt: null, decidedAt: null, generation: 0, allowance: false, recordings: false});
const validPolicy = value => value && typeof value === 'object' && [1, 2].includes(value.version) && (value.level === null || LEVELS.includes(value.level) || (value.version === 1 && ['counts','diagnostics'].includes(value.level))) &&
  (value.region === null || isRegionCode(value.region)) && isGeneration(value.generation) &&
  (value.noticeShownAt === null || Number.isFinite(value.noticeShownAt)) && (value.decidedAt === null || Number.isFinite(value.decidedAt)) && (value.allowance === undefined || typeof value.allowance === 'boolean') && (value.recordings === undefined || typeof value.recordings === 'boolean');

/**
 * `uploadable` is true for a build with a release VERSION and the build switch enabled; any other build is off.
 * `env` is read once, at start: an environment switch applies to this process only.
 */
export function createConsent({dir, base, env = {}, uploadable = false, now = Date.now, bytes}) {
  const policyFile = join(dir, 'policy.json'), stateFile = join(dir, 'state.json');
  const switchName = envSwitch(env);
  const installFile = join(dir, 'install.json');
  // Off writes this marker before policy.json and removes it only after the purge completes. While it exists, consent is
  // off; the next start (or the next consent change) finishes the purge before anything else.
  const pendingFile = join(dir, 'purge-pending.json'), lockFile = join(dir, 'consent.lock');
  let policy, unreadable = false, pending = false;
  /** Re-read the durable state. Other processes share the directory, so a cached view is only a hint. */
  function refresh() {
    policy = undefined; unreadable = false;
    try {
      const raw = JSON.parse(readFileSync(policyFile, 'utf8'));
      if (validPolicy(raw)) policy = raw; else unreadable = true;
    } catch (error) {
      if (error.code === 'ENOENT') policy = EMPTY_POLICY; else unreadable = true;
    }
    policy ??= EMPTY_POLICY;
    pending = existsSync(pendingFile);
  }
  refresh();
  // One authority for every process that shares this directory: consent writes, purges, and the last check before a
  // batch is dispatched all run under it, against freshly read state. Off therefore cannot complete between that check
  // and the dispatch. The work is synchronous, so the lock is never held across an await. Each file written under it is
  // fsynced by its writer; mutual exclusion does not depend on the lock directory's fsync, so it is skipped (the lock
  // is taken on every housekeeping tick).
  let held = false;
  function withAuthority(work,{wait=true}={}) {
    if (held) return work();
    const deadline = performance.now() + LOCK_WAIT_MS;
    let release;
    for (;;) {
      try { release = acquireProcessLockSync(lockFile, {durable: false}); break; } catch (error) {
        if (error.code !== 'lock_busy' || !wait || performance.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    held = true;
    try { refresh(); return work(); } finally { held = false; release(); }
  }
  /** Background work skips contention. A wrapper distinguishes a skipped lock from an undefined callback result. */
  function tryWithAuthority(work) {
    try {return {value:withAuthority(work,{wait:false})};}
    catch(error){if(error.code==='lock_busy')return null;throw error;}
  }
  // Public mutations retain their place while awaiting contention; no timeout silently loses an Off intent.
  let mutationTail=null;
  function mutate(work) {
    const start=()=>{
      const acquired=tryWithAuthority(work);if(acquired)return acquired.value;
      return (async()=>{for(;;){await pause(5);const retry=tryWithAuthority(work);if(retry)return retry.value;}})();
    };
    const result=mutationTail?mutationTail.then(start,start):start();
    if(result?.then){mutationTail=result;result.finally(()=>{if(mutationTail===result)mutationTail=null;}).catch(()=>{});}
    return result;
  }
  withAuthority(() => {
    if (!unreadable && policy.version === 1 && !pending) {
      const next = {...policy, version:2, level:policy.level === 'off' ? 'off' : policy.level === null ? null : 'on',
        generation:policy.generation + 1, noticeShownAt:null, allowance:true};
      saveJsonFile(pendingFile, next, {base});
      saveJsonFile(policyFile, next, {base});
      policy=next; pending=true;
    }
  });
  function installId() {
    return withAuthority(() => {
      if (current().effective === 'off') return null;
      try { const saved=JSON.parse(readFileSync(installFile,'utf8')); if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(saved.id)) return saved.id; } catch (error) { if(error.code !== 'ENOENT') throw error; }
      const id=installUuid(bytes); saveJsonFile(installFile,{id},{base}); return id;
    });
  }
  let epoch = null, session = randomId('s', bytes);
  try {
    const raw = JSON.parse(readFileSync(stateFile, 'utf8'));
    if (/^e-[A-Z2-7]{20}$/.test(raw?.epoch?.id) && Number.isFinite(raw.epoch.startedAt)) epoch = raw.epoch;
  } catch { /* no epoch yet */ }

  const startOfDay = ms => Math.floor(ms / DAY_MS) * DAY_MS;
  const newEpoch = () => {
    epoch = {id: randomId('e', bytes), startedAt: startOfDay(now())};
    session = randomId('s', bytes);
    saveJsonFile(stateFile, {epoch}, {base});
  };

  /** Local catalog correlation only; Cloud events use installId(). */
  function identity() {
    // Catalog correlation stays local. Creation here is memory-only: observation must never write disk.
    epoch ??= {id:randomId('e',bytes),startedAt:startOfDay(now())};
    return {epoch: epoch.id, session};
  }

  /** The state as last read: refreshed under the authority and by the surfaces. */
  function current() {
    const region = policy.region;
    const noticeShown = policy.noticeShownAt !== null;
    let level = 'off', reason;
    if (pending) reason = {kind:'purge_pending'};
    else if (switchName) reason = {kind:'env',env:switchName};
    else if (unreadable) reason = {kind: 'policy_unreadable'};
    else if (policy.level === 'off') reason = {kind:'choice'};
    else if (!uploadable) reason = {kind: 'no_upload'};
    else {
      const chosen = policy.level ?? regionDefault(region);
      if (!noticeShown) reason = {kind: 'notice_pending'};
      else { level = chosen; reason = {kind: policy.level ? 'choice' : 'default'}; }
    }
    return Object.freeze({level: policy.level, effective: level, streams: Object.freeze([...STREAMS_BY_LEVEL[level]]), reason, region, noticeShown, allowance: level === 'on', recordings: level === 'on' && policy.recordings === true,
      generation: policy.generation, uploadable, epochStartedAt: epoch?.startedAt ?? null});
  }

  /** Write the policy first; the caller applies the transition to queued records from {before, after}. */
  function write(changes) {
    return withAuthority(() => {
      // The facade finishes a pending purge first; a write over it could lose the Off it records.
      if (pending) throw Object.assign(new Error('telemetry_purge_pending'), {code: 'telemetry_purge_pending'});
      const before = current();
      // A corrupt file has lost its generation. Start a fresh random generation so delayed edge writes cannot match it.
      const generation = unreadable ? Buffer.from((bytes ?? randomBytes)(6)).readUIntBE(0, 6) + 1 : policy.generation + 1;
      const next = Object.freeze({...policy, ...changes, version: 2, generation});
      if (changes.level === 'off') { saveJsonFile(pendingFile, next, {base}); pending = true; }
      saveJsonFile(policyFile, next, {base});
      policy = next;
      unreadable = false;
      return {before, after: current()};
    });
  }

  return {
    current, identity, installId, refresh, withAuthority,tryWithAuthority,mutate,
    /** Publish only under the consent authority; a renewal after any gap gets a new nonce. */
    grantRemoteLease(gen) {
      return withAuthority(() => {
        const state=current();if(state.effective==='off' || state.generation!==gen)return null;
        const at=now(),previous=readRemoteLease({dir,generation:gen,at});
        const lease={version:1,enabled:true,generation:gen,id:previous?.id??installUuid(bytes),startedAt:previous?.startedAt??at,checkedAt:at};
        saveJsonFile(join(dir,REMOTE_LEASE_FILE),lease,{base});return lease;
      });
    },
    revokeRemoteLease() {
      // Removing permission can happen immediately, including while a writer holds the authority.
      rmSync(join(dir,REMOTE_LEASE_FILE),{force:true});syncDirectory(dir);
    },
    clearIdentity() { rmSync(installFile, {force:true}); rmSync(stateFile,{force:true}); epoch=null; syncDirectory(dir); },
    purgePending: () => withAuthority(() => pending),
    /** The purge is done: save the Off the marker records (its policy write may have failed), then drop the marker. */
    completePurge() {
      withAuthority(() => {
        if (!pending) return;
        const intent = JSON.parse(readFileSync(pendingFile, 'utf8'));
        if (!validPolicy(intent)) throw new Error('invalid_purge_intent');
        saveJsonFile(policyFile, intent, {base});
        rmSync(pendingFile, {force: true});
        syncDirectory(dir);
        refresh();
      });
    },
    /**
     * Start a request only if `gen` still allows `stream`, checked under the authority that Off takes. `send` must
     * start the request synchronously. Returns null when consent moved on, else {response}. A request started here
     * was dispatched before any later Off completed.
     */
    dispatch(gen, stream, send, allowed = () => true) {
      return tryWithAuthority(() => {
        const state = current();
        if (state.generation !== gen || !state.streams.includes(stream) || !allowed()) return null;
        return {response: send()};
      })?.value??null;
    },
    /** A person's choice from the local UI or CLI. Choosing also counts as having seen the notice. */
    choose({level, region, recordings, ...extra} = {}) {
      // Screen recordings are a separate, opt-in boolean. It needs reports On and is never carried over from an older choice.
      if (recordings !== undefined) {
        if (level !== undefined || region !== undefined || Object.keys(extra).length || typeof recordings !== 'boolean') throw Object.assign(new Error('invalid_request'), {code:'invalid_request'});
        return withAuthority(() => {
          const before = current();
          if (recordings && before.effective !== 'on') throw Object.assign(new Error('invalid_request'), {code:'invalid_request'});
          if (unreadable) return {before, after: before};
          return write({recordings});
        });
      }
      if (Object.keys(extra).length || !LEVELS.includes(level) || (region !== undefined && !isRegionCode(region))) throw Object.assign(new Error('invalid_request'), {code:'invalid_request'});
      return write({level, ...(level === 'off' ? {recordings:false} : {}), ...(region ? {region}:{}), decidedAt:now(), noticeShownAt:uploadable ? policy.noticeShownAt ?? now() : policy.noticeShownAt});
    },
    /** Off, from any surface, including MCP. */
    restrict: () => write({level: 'off', recordings: false, decidedAt: now(), noticeShownAt: policy.noticeShownAt ?? now()}),
    /**
     * The setup notice was displayed. A repeat writes nothing. A build that cannot upload shows no notice (only a line
     * saying so), so it records nothing: a later build with an upload destination must still show the notice first.
     */
    markNoticeShown() {
      // Notice idempotence and pending Off authority must use the same fresh
      // durable state as the write, including calls from a stale factory.
      return withAuthority(() => {
        if (pending || unreadable || policy.noticeShownAt !== null || !uploadable) return {before: current(), after: current()};
        return write({noticeShownAt: now()});
      });
    },
    /** A new pseudonym at once. The caller purges everything queued: a new ID carries nothing. */
    resetIdentity() {
      return withAuthority(() => {
        // The facade purges the old identity while reports are Off. Only a report choice can repair the policy.
        if (unreadable) { const before = current(); return {before, after: before}; }
        const result = write({});
        rmSync(installFile,{force:true});
        newEpoch();
        return result;
      });
    },
  };
}

/**
 * Run a synchronous edge write under the app's consent lock, using fresh policy and remote-lease evidence.
 * Missing/unreadable state, a pending purge, OFF or an expired lease return null without capturing anything.
 */
export function withEdgeLease({dir,env={},now=Date.now},capture) {
  if(!TELEMETRY_ENABLED || envSwitch(env))return null;
  let release;
  try {
    release=acquireProcessLockSync(join(dir,'consent.lock'),{durable:false});
    if(existsSync(join(dir,'purge-pending.json')))return null;
    const policy=JSON.parse(readFileSync(join(dir,'policy.json'),'utf8'));
    if(!validPolicy(policy) || policy.version!==2 || policy.noticeShownAt===null || policy.level==='off')return null;
    const at=now(),lease=readRemoteLease({dir,generation:policy.generation,at});
    if(!lease)return null;
    return capture({gen:policy.generation,capture:{lease_id:lease.id,captured_at:at}});
  }catch{return null;}finally{release?.();}
}
/** Read-only status hint. Writers must use withEdgeLease so permission cannot change during their write. */
export function edgeGeneration(options) {
  return withEdgeLease(options,state=>state.gen);
}
