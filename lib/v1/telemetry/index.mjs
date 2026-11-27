// Telemetry: the one facade the app imports. It wires projection -> rollup -> outbox -> uploader under consent, ingests
// the inbox of outside producers, and pulls an hourly health snapshot. Design §2.2.
//
// Request opt-outs persist synchronously; failed privacy writes are reported to the admission caller.
// Observations add to memory. Records reach the outbox from tick(),
// which also saves rollup state; network work is confined to Cloud delivery and the boolean stop flag.
// An opted-out job is accepted only after its privacy restriction is durable.
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { saveJsonFile } from '../../local-state.mjs';
import { ensureDurableDirectory, syncDirectory } from '../../durable-directory.mjs';
import { CATALOG, SCHEMA_VERSION, MAX_INBOX_FILE_BYTES, TelemetrySchemaError, parseRecord, parseInboxFile, parseVersion } from './catalog.mjs';
import { createRemoteStop } from './remote-stop.mjs';
import {readRemoteLease,captureWithinLease} from './remote-lease.mjs';
import { stampRecord } from './posthog.mjs';
import { createConsent } from './consent.mjs';
import { createOutbox, laneOf } from './outbox.mjs';
import { project } from './projection.mjs';
import { createRollup } from './rollup.mjs';
import {createRequestPrivacy,privacyUnavailable} from './request-privacy.mjs';
import { createTripwire } from './tripwire.mjs';
import { createUploader } from './uploader.mjs';
import { SURFACE_HEADER, scopeOf } from './switch.mjs';

export { BOOTSTRAP_ROUTE, CONSENT_SETTING, FACT_SCHEMAS, PERSON_PROPERTIES } from './contract.mjs';
import { stoppedBootstrap, TELEMETRY_ENABLED, POSTHOG_HOST, parseFact } from './contract.mjs';

export { writeCrashFile } from './crash.mjs';
export { regionDefault, isRegionCode } from './consent.mjs';
export { envSwitch, scopeOf } from './switch.mjs';

/** Fixed public Cloud ingestion URL. Build and consent switches gate all requests. */
export const TELEMETRY_ENDPOINT = POSTHOG_HOST + '/batch/';
const MAX_INBOX_FILES = 200;
const TICK_MS = 5000, INBOX_MS = 60000, UPLOAD_MS = 30000, SAVE_MS = 60000, HOURLY = 3600000;
const JITTER = {hour: 10 * 60000, day: 6 * HOURLY, quota: 48 * HOURLY};


/**
 * dir: <home>/v1/telemetry. version: the packaged VERSION, or null for a source checkout (which never uploads).
 * health(): raw status objects the app already holds, no I/O (see projection `health`). preset(): the lending preset id.
 */
function build({dir, base, env = process.env, version = null, enabled = TELEMETRY_ENABLED, transport, now = Date.now,
  bytes, random = Math.random, health = () => ({}), preset = () => 'unknown', tripwire = createTripwire({now}), setTimer = setInterval, clearTimer = clearInterval,
  intervals = {}, remoteFactory=createRemoteStop}) {
  ensureDurableDirectory(dir, {base});
  const uploadable = Boolean(TELEMETRY_ENABLED && enabled && parseVersion(version));
  const consent = createConsent({dir, base, env, uploadable, now, bytes});
  const inboxDir = join(dir, 'inbox'), rollupFile = join(dir, 'rollup.json'), markerFile = join(dir, 'running.json');

  // What capture may do right now: the generation and the streams the consent allows.
  const capture = () => { const c = consent.current(); return {gen: c.generation, streams: c.streams}; };
  const rollup = createRollup({now, identity: () => consent.identity(), bytes, onSelf: (reason, entry, n) => self(reason, entry, n)});
  // An Off whose purge did not finish (a crash or a disk error) is finished before anything opens the queue. Off with no
  // marker purges too, so bytes a failed purge left behind cannot outlive a restart. This runs before the outbox opens:
  // the purge outranks recovering an interrupted lane rewrite.
  // Recovery of an interrupted lane rewrite (createOutbox) runs under the same authority, so a concurrent Off cannot
  // complete between the purge and the replay and have the replay write a survivor back.
  let remote=null;
  const outbox = consent.withAuthority(() => {
    if (consent.purgePending() || consent.current().level === 'off') {
      for (const name of ['outbox', 'sent', 'inbox','caps.json']) rmSync(join(dir, name), {recursive: true, force: true});
      rmSync(rollupFile, {force: true});
      rmSync(markerFile, {force: true});
      syncDirectory(dir);
      consent.clearIdentity();
      consent.completePurge();
    }
    return createOutbox({dir, base, now, bytes, onDrop: (reason, n, entry) => self(reason, entry, n)});
  });
  let savedRollup;try{savedRollup=JSON.parse(readFileSync(rollupFile,'utf8'));}catch{}
  const privacy=createRequestPrivacy({dir,base,now,initial:savedRollup});
  let rawFacts=[], rawBytes=0, started=false, markerHandled=false;
  let caps={day:null,count:0,heartbeat:-Infinity,profiles:{}};
  const capsFile=join(dir,'caps.json');
  try { const saved=JSON.parse(readFileSync(capsFile,'utf8')); if(saved.day===new Date(now()).toISOString().slice(0,10) && Number.isSafeInteger(saved.count))caps=saved; } catch {}
  function discardForRemoteStop() {
    uploader.abort();
    const acquired=consent.tryWithAuthority(() => {rawFacts=[];rawBytes=0;markerHandled=false;rmSync(markerFile,{force:true});outbox.purge();rollup.reset({keepSuppressions:true});rmSync(rollupFile,{force:true});clearInbox();});
    return Boolean(acquired);
  }
  remote=remoteFactory({consent,transport,now,onStop:discardForRemoteStop});
  const uploader = createUploader({consent, outbox, transport, version, tripwire, now, random, onSelf: (reason, entry) => self(reason, entry), allowed:remote.allowed});
  let timers = [], lastSave = now(), lastHealthHour = null, lastBounds = now(), closed = false;

  /** Count a thing telemetry itself did or dropped. */
  function self(reason, entry = 'none', n = 1) {
    if(!remote?.allowed())return;
    rollup.observe({op: 'count', name: 'telemetry.self', attrs: {reason, entry: CATALOG.entries[entry] ? entry : 'none'}, n}, capture());
  }

  const reservations=new WeakMap();
  let lastHealth = null; // the last hourly pull: problem exemplars carry its readiness snapshot
  const ctx = (extra = {}) => {
    const t = new Date(now()).toISOString();
    return {origin: 'app', hour: t.slice(0, 13), day: t.slice(0, 10), now: now(), level: 'diagnostics', preset: preset(), health: lastHealth,
      allowance: consent.current().effective !== 'off' && consent.current().allowance === true, ...extra};
  };

  function observe(kind, data, scope = {}) {
    try {
      if (closed) return;
      // Request opt-outs are privacy state, not observations enabled by the remote flag.
      if(scope.off) {
        for(const observation of project(kind,data,{}))if(observation.op==='suppress'){privacy.suppress(observation.key);rollup.observe(observation,capture());}
        return;
      }
      if(consent.current().effective==='off' || !remote.allowed())return;
      const privacyState=privacy.snapshot();
      if(privacyState.pendingUntil>now()&&['event:job','event:lending'].includes(kind))return;
      rollup.restorePrivacy(privacyState);
      if(kind==='event:job'&&!rollup.jobAllowed('borrower:'+data?.job_digest))return;
      const readiness = kind === 'event:readiness' ? health()?.readiness : undefined;
      let observations = project(kind, data, ctx({origin: scope.origin, readiness}));
      const current = capture();
      for (const o of observations) rollup.observe(o, current);
    } catch(error) {
      if(error.code==='telemetry_privacy_unavailable')throw error;
      /* telemetry never fails its caller */
    }
  }

  /** Closed schema facts append only to bounded memory; tick owns disk work. */
  function observeFact(name, properties, options={}) {
    try {
      const c=consent.current();
      if(closed || c.effective==='off' || !remote.allowed() || options.off || scopeOf(options.headers).off)return false;
      const parsed=parseFact(name,properties);
      const surface=options.surface??'background';
      if(!CATALOG.enums.surface.some(item=>item.value===surface))return false;
      const day=new Date(now()).toISOString().slice(0,10);
      if(caps.day!==day)caps={day,count:0,heartbeat:-Infinity,profiles:{}};
      if(caps.count>=10000 || (name==='app_heartbeat'&&now()-caps.heartbeat<300000))return false;
      const profile=['system_profile_observed','account_plan_observed','resource_constraints_observed'].includes(name);
      const profileKey=name+':'+(parsed.provider??'none'), signature=JSON.stringify(parsed);
      if(profile && caps.profiles[profileKey]===signature)return false;
      const record=stampRecord({name,properties:parsed,origin:surface==='phone'?'phone':surface==='ui'?'ui':'app'},{at:now(),surface,bytes});
      const size=Buffer.byteLength(JSON.stringify(record));
      if(rawFacts.length>=10000 || rawBytes+size>1024*1024)return false;
      rawFacts.push({record,gen:c.generation,at:now(),notBefore:0});rawBytes+=size;caps.count++;
      if(profile)caps.profiles[profileKey]=signature;
      if(name==='app_heartbeat')caps.heartbeat=now();
      return true;
    } catch {return false;}
  }

  /** Before accepting an opted-out job, persist a reservation. Failure refuses admission with a 503 error. */
  function prepareRequest(req,frozen) {
    if(frozen?.optOut??scopeOf(req?.headers).off)reservations.set(req,privacy.reserve());
  }
  /** Response writers bind the reservation to a confirmed digest; an unknown outcome keeps the blanket refusal. */
  function response(info) {
    try {
      const token=info.req&&reservations.get(info.req);
      if(token) {
        const digest=info.body?.job_digest??info.body?.jobDigest;
        if(typeof digest==='string'&&/^sha256:[0-9a-f]{64}$/.test(digest))privacy.bind(token,'borrower:'+digest);
        // Without a confirmed digest the request may have succeeded remotely: retain the durable blanket refusal.
        reservations.delete(info.req);return;
      }
      const {writer, req, status, body, opId, fromRest, durationMs} = info;
      const headers = req?.headers ?? {};
      let parts = [];
      try { parts = new URL(req.url, 'http://local').pathname.split('/').filter(Boolean); } catch { /* no path */ }
      const given = headers[SURFACE_HEADER];
      const scope = scopeOf(headers);
      observe('response', {status, body, writer, opId, fromRest, durationMs, area: writer === 'ops' ? 'ops' : parts[0] === 'api' ? parts[1] : parts[0], scopeOff: scope.off,
        surface: writer === 'phone' ? 'phone' : ['cli', 'mcp', 'ui'].includes(given) ? given : 'http'}, scope);
    } catch(error) {if(error.code==='telemetry_privacy_unavailable')throw error; /* observation is otherwise optional */ }
  }

  /** Friction records from the UI or a paired phone: at most 20 per request, each validated by projection. */
  function ui(records, options) {
    try {
      if (!Array.isArray(records)) return;
      const scope = {...scopeOf(options?.headers), origin: options?.origin ?? 'ui'};
      for (const record of records.slice(0, 20)) {
        if(record?.name)observeFact(record.name,record.properties,{...scope,surface:scope.origin,headers:options?.headers});
        else observe('ui', record, scope);
      }
    } catch { /* ignored: friction is optional */ }
  }

  // ---- records to the outbox -------------------------------------------------------------------------------------
  function toOutboxItem({stream, gen, record}) {
    let wire;
    try { wire = parseRecord(record, {origin: record.origin ?? 'app', schemaVersion: SCHEMA_VERSION}); } catch (error) {
      if (!(error instanceof TelemetrySchemaError)) throw error;
      self('internal_error', record?.name);
      return null;
    }
    const entry = CATALOG.entries[wire.name];
    const wait = stream === 'quota' ? JITTER.quota : stream === 'counts' ? JITTER[entry.period] : 0;
    return {record: wire, gen, notBefore: now() + random() * wait, at: now()};
  }
  /** Finished records to the outbox: validated once more, then written with one fsync per lane. */
  function drain(records) {
    if (!records.length) return;
    // The rollup state without these records is written first, so a crash cannot offer them again from an older state
    // (a crash right here costs the records, not a double count). If the save or the hand-over then fails, the records go
    // back and the next pass retries; lanes that were already written are not offered twice.
    const items = records.map(item => ({item, out: toOutboxItem(item)})).filter(({out}) => out);
    try {
      saveRollup(true);
      outbox.append(items.map(({out}) => out));
    } catch (error) {
      const done = error?.committedLanes ?? new Set();
      rollup.restoreReady(records.filter(item => !items.some(entry => entry.item === item && done.has(laneOf(entry.out.record)))));
      throw error;
    }
  }

  function saveRollup(force = false) {
    if (!force && (!rollup.isDirty() || now() - lastSave < SAVE_MS)) return;
    saveJsonFile(rollupFile, rollup.snapshot(), {base});
    lastSave = now();
    rollup.markClean(); // only now: a failed write leaves the state unsaved, so the next tick tries again
  }

  /** One round of housekeeping: finished records to the outbox, rollup state to disk, the hourly health pull. */
  function tick() {
    remote.poll().catch(()=>{});
    try {
      consent.tryWithAuthority(() => {
        if (closed || consent.current().effective === 'off' || !remote.allowed()) return;
        const privacyState=privacy.snapshot();if(privacyState.pendingUntil>now())return;
        rollup.restorePrivacy(privacyState);
        if(started && !markerHandled) {
          markerHandled=true;
          if(existsSync(markerFile))for(const observation of project('marker',{service:'app'}))rollup.observe(observation,capture());
          writeFileSync(markerFile,JSON.stringify({pid:process.pid,startedAt:now()}),{mode:0o600});
        }
        const hour = new Date(now()).toISOString().slice(0, 13);
        if (hour !== lastHealthHour) { lastHealthHour = hour; pullHealth(); }
        if(rawFacts.length) {
          const gen=consent.current().generation,day=new Date(now()).toISOString().slice(0,10);
          let stored={day,count:0};
          try {const saved=JSON.parse(readFileSync(capsFile,'utf8'));if(saved.day===day&&Number.isSafeInteger(saved.count)&&saved.count>=0)stored=saved;}catch(error){if(error.code!=='ENOENT')throw error;}
          const items=rawFacts.filter(item=>item.gen===gen).slice(0,Math.max(0,10000-stored.count));
          // Reserve before append: a crash or full disk may lose observations, never exceed the daily cap.
          caps={...caps,day,count:stored.count+items.length};
          saveJsonFile(capsFile,caps,{base});
          rawFacts=[];rawBytes=0;
          outbox.append(items);
        }
        drain(rollup.closeDue(capture()));
        if (now() - lastBounds > HOURLY) { lastBounds = now(); outbox.enforceBounds(); outbox.enforceSent(); }
        saveRollup();
      });
    } catch {
      /* the next tick tries again */
    }
  }
  function pullHealth() {
    try {
      const snapshot = lastHealth = health() ?? {};
      const stats = outbox.stats();
      observe('health', {...snapshot, outbox: {degraded: stats.bytes > 0.8 * 10 * 1024 * 1024}});
    } catch { /* a provider failed: the snapshot is skipped */ }
  }

  // ---- inbox: files from the tray, installer, coordinator and crash marker -------------------------------------------
  /** Every file is untrusted: validate its generation and project it under the current consent. */
  function ingestInbox() {
    try {
      if (!remote.allowed() || !existsSync(inboxDir)) return;
      consent.tryWithAuthority(() => {
        const c = consent.current();
        if(c.effective==='off')return;
        const names = readdirSync(inboxDir).filter(name => name.endsWith('.json')).sort();
        names.forEach((name, index) => {
          const file = join(inboxDir, name);
          // Untrusted: a directory or anything else named like a file is removed too, and never stops the sweep.
          const discard = reason => { try { rmSync(file, {recursive: true, force: true}); } catch { /* left for the next sweep */ } self(reason); };
          try {
            if (index >= MAX_INBOX_FILES || statSync(file).size > MAX_INBOX_FILE_BYTES) return discard('inbox_invalid');
            const parsed = parseInboxFile(readFileSync(file, 'utf8'));
            // Both the consent generation and the uninterrupted remote lease must still authorize this capture.
            const at=now(),lease=readRemoteLease({dir,generation:c.generation,at});
            if (parsed.gen === 0 || parsed.gen !== c.generation || !captureWithinLease(parsed.capture,lease,at)) return discard('stale_generation');
            if (c.effective === 'off') return rmSync(file, {force: true});
            const current = capture();
            for (const o of project('inbox', {record: parsed.record, origin: parsed.origin}, ctx())) rollup.observe(o, current);
            rmSync(file, {force: true});
          } catch (error) {
            discard('inbox_invalid');
          }
        });
      });
    } catch { /* an unreadable inbox is retried at the next sweep */ }
  }

  // ---- consent transitions -------------------------------------------------------------------------------------------
  /** Delete everything queued, sent or saved, then clear a pending Off marker. Every step is idempotent, so a retry finishes it. */
  function purge() {
    rawFacts=[]; rawBytes=0; markerHandled=false;
    rmSync(markerFile,{force:true});
    caps={day:null,count:0,heartbeat:-Infinity,profiles:{}};
    rmSync(capsFile,{force:true});
    outbox.purge();
    rollup.reset();
    clearInbox();
    rmSync(rollupFile, {force: true});
    syncDirectory(join(dir, 'outbox'));
    syncDirectory(join(dir, 'sent'));
    syncDirectory(dir);
    consent.clearIdentity();
    consent.completePurge();
  }
  function clearInbox() { rmSync(inboxDir, {recursive: true, force: true}); }
  /** Apply a consent change to what is queued. The policy is already written; the generation check is the guarantee, this is the cleanup. */
  function transition({before, after}, {carries = true} = {}) {
    uploader.abort();
    remote.reset();
    if (before.reason.kind === 'policy_unreadable') clearInbox();
    if (after.effective === 'off') {
      rmSync(markerFile, {force: true});
      purge();
    } else if (!carries) {
      purge();
    } else {
      const streams = before.streams.filter(stream => after.streams.includes(stream));
      outbox.carry({streams, fromGen: before.generation, gen: after.generation});
      rollup.carry({fromGen: before.generation, gen: after.generation, streams});
      // Files waiting in the inbox keep their stamp: a mismatch with the new generation drops them at the next sweep.
    }
    if (after.effective !== 'off') saveRollup(true);
    return consent.current();
  }

  /** Apply a consent change under the authority, awaiting contention. Callers must await before acknowledging it. */
  function change(write, options) {
    return consent.mutate(() => {
      if (consent.purgePending()) { uploader.abort(); purge(); }
      return transition(write(), options);
    });
  }

  // ---- lifecycle ---------------------------------------------------------------------------------------------------
  try {
    rollup.restore(savedRollup, {gen: consent.current().generation});
  } catch { /* no saved state */ }
  rollup.restorePrivacy(privacy.snapshot());
  // The read side never throws either: a broken outbox shows as empty.
  const safely = (work, fallback) => { try { return work(); } catch { return fallback; } };
  function publicView(c, {showQueued = true} = {}) {
    const emptyQueue = {queued: {counts: 0, diagnostics: 0, quota: 0}, bytes: 0};
    const stats = showQueued ? safely(() => outbox.stats(), emptyQueue) : emptyQueue;
    const up = uploader.status();
    return {level: c.level, effective: c.effective, reason: c.reason, region: c.region, notice: {shown: c.noticeShown, pending: c.reason.kind === 'notice_pending' || (c.reason.kind === 'no_upload' && !c.noticeShown && c.level === null)},
      allowance: c.allowance, recordings: c.recordings, uploadable: c.uploadable, endpoint_configured: Boolean(uploadable), version, queued: stats.queued, queued_bytes: stats.bytes,
      upload: {halted: up.halted, backoff_until: up.backoffUntil ? new Date(up.backoffUntil).toISOString() : null, last_status: up.last.status}};
  }

  return {
    observe, response, prepareRequest, ui, tick, ingestInbox,
    /** Validated facts append to bounded memory only. */
    observeFact,
    /** Exposed only after app authentication, with request-scope restrictions. */
    bootstrap({headers} = {}) {
      return consent.tryWithAuthority(() => {
        const c=consent.current(), on=c.effective === 'on' && !scopeOf(headers).off;
        return {installId:on ? consent.installId():null,consent:on?'on':'off',generation:c.generation,remoteEnabled:on && remote.allowed(),recordings:on && c.recordings,noticePending:!c.noticeShown && c.reason.kind!=='policy_unreadable'};
      })?.value??stoppedBootstrap();
    },
    /** Run the timers: housekeeping every 5 s, the inbox every 60 s, the uploader every 30 s. Tests call tick() and flushNow() themselves. */
    start() {
      started=true;
      ingestInbox(); tick();
      timers = [setTimer(tick, intervals.tick ?? TICK_MS), setTimer(ingestInbox, intervals.inbox ?? INBOX_MS), setTimer(() => { uploader.flushNow().catch(() => {}); }, intervals.upload ?? UPLOAD_MS)];
      for (const timer of timers) timer.unref?.();
    },
    /** Upload what is due now. */
    flushNow: async () => { await remote.poll(); tick(); try { await uploader.flushNow(); } catch { /* the next pass tries again */ } },
    /** Public status for settings; bootstrap carries the install identity only to authenticated callers. */
    view() {
      consent.refresh();
      return publicView(consent.current());
    },
    status: () => { consent.refresh(); return {...consent.current(), version, endpointConfigured: Boolean(uploadable), upload: uploader.status(), outbox: safely(() => outbox.stats(), {queued: {counts: 0, diagnostics: 0, quota: 0}, bytes: 0})}; },
    choose: choice => change(() => consent.choose(choice)),
    restrict: () => change(() => consent.restrict()),
    markNoticeShown: () => change(() => consent.markNoticeShown()),
    resetIdentity: () => change(() => consent.resetIdentity(), {carries: false}),
    /** The exact bytes queued and sent: what "See what we send" shows. */
    preview() {
      consent.refresh();
      const c = consent.current();
      const showQueued = c.effective !== 'off';
      const items = safely(() => outbox.inspect({gen: c.generation, at: now()}), [])
        .filter(item => showQueued || item.state !== 'queued')
        .map(item => ({...item, at: new Date(item.at).toISOString()}));
      return {state: publicView(c, {showQueued}), items};
    },
    async close() {
      if (closed) return;
      tick();
      remote.cancel();
      for (const timer of timers) clearTimer(timer);
      timers = [];
      try {
        consent.tryWithAuthority(() => {
          if (consent.current().effective !== 'off') { drain(rollup.flush(capture())); saveRollup(true); }
        });
      } catch { /* shutdown continues */ }
      closed = true;
      // Shutdown never throws into the app's own teardown.
      try { await uploader.stop({timeoutMs: 2000}); } catch { /* nothing to wait for */ }
      try { rmSync(markerFile, {force: true}); } catch { /* the next start counts an unclean exit */ }
    },
  };
}

/** The same facade with nothing behind it: what the app gets when telemetry cannot be set up (its directory is unwritable, say). */
function unavailable() {
  const view = {level: null, effective: 'off', reason: {kind: 'unavailable'}, region: null, notice: {shown: false, pending: false}, uploadable: false, endpoint_configured: false, version: null,
    queued: {counts: 0, diagnostics: 0, quota: 0}, queued_bytes: 0, upload: {halted: false, backoff_until: null, last_status: null}};
  const nothing = () => {};
  // Off must not report success when it never reached the policy: the caller learns that consent was not changed.
  const refuse = () => { throw Object.assign(new Error('telemetry_unavailable'), {code: 'telemetry_unavailable'}); };
  return {prepareRequest(req){if(scopeOf(req?.headers).off)throw privacyUnavailable();},observeFact: () => false, bootstrap: stoppedBootstrap, observe: nothing, response: nothing, ui: nothing, tick: nothing, ingestInbox: nothing, start: nothing, flushNow: async () => {}, view: () => view, status: () => ({...view, generation: 0}),
    choose: refuse, restrict: refuse, markNoticeShown: refuse, resetIdentity: refuse, preview: () => ({state: view, items: []}), close: async () => {}};
}

/** Telemetry is optional: a failure to set it up is not the app's failure. */
export function createTelemetry(options) {
  try { return build(options); } catch { return unavailable(); }
}
