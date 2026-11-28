import { verifyMemberProfile } from './member-profile.mjs';
import { verifyInvitationRevocation, verifyEnrollmentRejection } from './invitation-revoke.mjs';
import { MODEL_EFFORT_PAIRS_CAPABILITY, RUN_REQUEST_CAPABILITY, DESIGNATED_MEMBER_CAPABILITY, HOST_CAPABILITIES, TRANSCRIPT_RELAY_LIMITS, isVersion, changedMembershipCapabilities } from './versions.mjs';
import { validateAccountAdvertisement, resolveSelection, selectionSatisfies, accountsForProviders, MAX_RUN_ID_LENGTH } from './run-request.mjs';
import {jobWatchRevision} from './job-watch.mjs';
import {observedExecutionTime, launchFenceBound, MAX_LEASE_SECONDS} from './state-projection.mjs';
import { isOperationKey } from './outcome.mjs';
import { isStartFailure } from './failures.mjs';
import { mkdirSync, existsSync, openSync, closeSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID,generateKeyPairSync,createPrivateKey,createPublicKey } from 'node:crypto';
import {signLease} from './account-authority.mjs';
import * as p from '../protocol/index.mjs';

const DAY = 86400;
// Presence and empty polls are retryable control traffic, not daily user mutations.
// Keep the protocol's full-day replay guarantee, with a separate finite polling budget.
const CONTROL_IDEMPOTENCY_SECONDS = DAY;
const MAX_PUBLICATION_BYTES = 8192;
const MAX_CONTROL_BYTES = 262144;
const controlBytes = value => Buffer.byteLength(p.canonicalize(value));
const responseLimit = ctx => Math.min(ctx?.maxResponseBytes??MAX_CONTROL_BYTES,MAX_CONTROL_BYTES);
const PAGE_CURSOR = '00000000-0000-0000-0000-000000000000';
function checkJobPage(value,ctx) {
  need(controlBytes({items:[value],next_cursor:PAGE_CURSOR})<=responseLimit(ctx),'payload_too_large');
}
function admitJob(signed,digest,ctx) {
  need(!(signed.payload.source_manifest?.not_sent??[]).some(item=>Object.hasOwn(item,'path')));
  // Reserve every bounded field before accepting an immutable job. A control
  // character needs six canonical JSON bytes, the largest per-code-point case.
  const stamp='9999-12-31T23:59:59Z',hash='sha256:'+'0'.repeat(64);
  let selection;
  if(signed.payload.runRequest){
    const longestId='\u0000'.repeat(MAX_RUN_ID_LENGTH),request=signed.payload.runRequest;
    // Account and default effort are chosen later; explicit provider/model pairs stay bound to the signed request.
    const model=request.models==='any'?{providerId:longestId,modelId:longestId}:
      request.models.reduce((largest,next)=>controlBytes(next)>controlBytes(largest)?next:largest);
    selection={...model,accountId:longestId,effortId:request.effortId??longestId};
  }
  checkJobPage({job_digest:digest,job:signed,state:'result-accepted',
    attempts_started:signed.payload.max_attempts??3,result_digest:hash,
    current_attempt:{attempt_id:PAGE_CURSOR,job_digest:digest,generation:Number.MAX_SAFE_INTEGER,
      holder:hash,state:'cancelled',claimed_at:stamp,lease_expires_at:stamp,
      execution_started_at:stamp,...(selection?{selection}:{}),reason:'\u0000'.repeat(4096),compute_stopped:false,stopped_at:stamp}},ctx);
}
const DEFAULT_LIMITS = {deviceBytes:10*1073741824,circleBytes:100*1073741824,maxArtifactBytes:1073741824,concurrentUploads:2,
  deviceArtifacts:10000,circleArtifacts:100000,unreferencedArtifactGraceSeconds:DAY,
  circleMetadataBytes:16*1048576,circleMetadataRows:10000,rosterHistoryRows:32,
  transcriptCircleBytes:16*1048576,transcriptDeviceBytes:4*1048576,
  circleJobs:10000,deviceJobs:1000,maxJobLifetimeSeconds:7*DAY,terminalRetentionSeconds:30*DAY,nonceRows:100000,noncesPerDevice:2048,writeNonceReserve:256,
  idempotencyRows:131072,idempotencyRowsPerDevice:16384,idempotencyBytes:128*1048576,idempotencyBytesPerDevice:16*1048576,
  controlIdempotencyRows:1048576,controlIdempotencyRowsPerDevice:131072,
  controlIdempotencyBytes:256*1048576,controlIdempotencyBytesPerDevice:32*1048576};
const TERMINAL = new Set(['result-accepted', 'failed', 'expired', 'cancelled']);
const ONLINE_SECONDS = 90;
// A job fails for start failures only this long after the first one counted, so a restart loop cannot spend the attempts in minutes.
const START_FAILURE_FLOOR_SECONDS = 30 * 60;
const HEARTBEAT_INTENTS = ['off','paused','outside','resting','ready','starting','blocked','update'];
const HEARTBEAT_EXECUTIONS = ['idle','running','finishing','stopping'];
const PROGRESS_STEP_MAX = 120, PROGRESS_PER_ATTEMPT = 40, PROGRESS_MIN_SECONDS = 10;
const iso = t => new Date(t * 1000).toISOString().replace('.000Z', 'Z');
const seconds = s => Date.parse(s) / 1000;
const clone = x => structuredClone(x);
const fail = code => { throw new p.ProtocolError(code); };
const need = (condition, code = 'invalid_request') => { if (!condition) fail(code); };
const stable = new Set(['invalid_request','wrong_circle','digest_mismatch','size_mismatch','cursor_invalid',
  'unauthenticated','invalid_signature','replay','forbidden','not_found','conflict','idempotency_conflict',
  'stale_attempt','lease_expired','job_terminal','retry_exhausted','roster_stale','enrollment_conflict','invite_used',
  'artifact_missing','job_expired','roster_expired','enrollment_expired','payload_too_large',
  'requirements_unsupported','quota_exceeded','rate_limited','unsupported_version','unavailable','internal_error']);
function checked(result) {
  if (!result.ok) fail(stable.has(result.code) ? result.code :
    ['author_mismatch','executor_mismatch','key_mismatch'].includes(result.code) ? 'forbidden' : 'invalid_request');
  return result;
}
function envelope(value) {
  return typeof value === 'string' || value instanceof Uint8Array ? p.strictParse(value) : p.strictParse(p.canonicalize(value));
}
function refValid(ref) {
  need(ref && /^[a-f0-9]{64}$/.test(ref.digest?.slice(7)) && ref.digest.startsWith('sha256:'));
  need(Number.isSafeInteger(ref.bytes) && ref.bytes >= 0 && ref.bytes <= 1073741824);
  need(['application/gzip','text/x-diff','text/plain','application/x-ndjson'].includes(ref.media_type));
}
function leaseDuration(value) { need(Number.isInteger(value) && value >= 30 && value <= MAX_LEASE_SECONDS); return value; }
function exclusions(value = []) {
  need(Array.isArray(value) && value.length <= 64 && value.every(id => typeof id === 'string' && /^sha256:[a-f0-9]{64}$/.test(id)));
  return new Set(value);
}
function advertisementValid(value) {
  const minimum={capabilities:[],egress:'provider-only',limits:{wall_seconds:1,cpu:1,memory_bytes:1048576,disk_bytes:1048576,output_bytes:1}};
  const result=p.canSatisfy(minimum,value);
  need(!result.unmet?.includes('lenderCapabilities'),'requirements_unsupported');
}

/**
 * Durable, synchronous single-circle domain store. Every request context is {proof}.
 * The initial roster is an explicit out-of-band provision, never a network write.
 * Blob IO is the caller's responsibility; commitArtifact takes verified stream metadata.
 */
// SQLite creates database files with the process umask (usually 0644) and gives
// the -wal/-shm files the main file's mode. Create the file 0600 first and
// correct any older copy, so the job data stays owner-only even if the
// enclosing directory mode is later loosened or the file is copied.
export function createPrivateFile(path) {
  closeSync(openSync(path, 'a', 0o600));
  chmodSync(path, 0o600);
}
export function openV1Store({path, clock = () => Math.floor(Date.now()/1000), idGenerator = randomUUID,
  circle, rootFingerprint, origin, initialRoster, lanMode, quotas = {}, faravanVersion = null, minMember = null, busyTimeoutMs = 5000} = {}) {
  need(typeof path === 'string' && typeof clock === 'function' && typeof idGenerator === 'function');
  need(Number.isSafeInteger(busyTimeoutMs)&&busyTimeoutMs>=0&&busyTimeoutMs<=2147483647);
  createPrivateFile(path);
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;`);
    db.exec(`
    CREATE TABLE IF NOT EXISTS circle (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rosters (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invites (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS invite_codes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS enrollments (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS leave_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS member_origins (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS attempt_stop_requests (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS results (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS cancellations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS idempotency (device TEXT, key TEXT, request_digest TEXT NOT NULL, response TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(device,key));
    CREATE TABLE IF NOT EXISTS nonces (device TEXT, nonce TEXT, expires INTEGER NOT NULL, PRIMARY KEY(device,nonce));
    CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artifact_holders (digest TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY(digest,device));
    -- A result file named by a job that is still open for delivery. Retirement and grace collection leave it alone.
    CREATE TABLE IF NOT EXISTS delivery_holds (digest TEXT NOT NULL, job TEXT NOT NULL, device TEXT NOT NULL, PRIMARY KEY(digest,job));
    CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS quota_counters (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS artifact_counts (device TEXT PRIMARY KEY, retained INTEGER NOT NULL, reserved INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS artifact_count_insert AFTER INSERT ON artifacts BEGIN
      INSERT INTO artifact_counts VALUES('',1,0) ON CONFLICT(device) DO UPDATE SET retained=retained+1;
      INSERT INTO artifact_counts VALUES(json_extract(NEW.data,'$.uploader'),1,0) ON CONFLICT(device) DO UPDATE SET retained=retained+1;
    END;
    CREATE TRIGGER IF NOT EXISTS artifact_count_delete AFTER DELETE ON artifacts BEGIN
      UPDATE artifact_counts SET retained=retained-1 WHERE device IN ('',json_extract(OLD.data,'$.uploader'));
    END;
    CREATE TRIGGER IF NOT EXISTS reservation_count_insert AFTER INSERT ON reservations BEGIN
      INSERT INTO artifact_counts VALUES('',0,1) ON CONFLICT(device) DO UPDATE SET reserved=reserved+1;
      INSERT INTO artifact_counts VALUES(json_extract(NEW.data,'$.device'),0,1) ON CONFLICT(device) DO UPDATE SET reserved=reserved+1;
    END;
    CREATE TRIGGER IF NOT EXISTS reservation_count_delete AFTER DELETE ON reservations BEGIN
      UPDATE artifact_counts SET reserved=reserved-1 WHERE device IN ('',json_extract(OLD.data,'$.device'));
    END;
    CREATE INDEX IF NOT EXISTS artifacts_unreferenced ON artifacts(json_extract(data,'$.pinned'),json_extract(data,'$.created'));
    CREATE INDEX IF NOT EXISTS reservation_digest ON reservations(json_extract(data,'$.ref.digest'));
    CREATE TABLE IF NOT EXISTS cursors (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS revoked_devices (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS job_queue (id TEXT PRIMARY KEY, egress TEXT NOT NULL, ready INTEGER NOT NULL, expiry INTEGER NOT NULL, published INTEGER NOT NULL, requirements TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS job_queue_eligible ON job_queue(egress,ready,expiry);
    CREATE INDEX IF NOT EXISTS job_queue_expiry ON job_queue(expiry);
    CREATE INDEX IF NOT EXISTS job_terminal_retention ON jobs(json_extract(data,'$.terminal_at'));
    CREATE INDEX IF NOT EXISTS jobs_author ON jobs(json_extract(data,'$.author'));
    CREATE INDEX IF NOT EXISTS attempts_job ON attempts(json_extract(data,'$.job_digest'));
    CREATE TABLE IF NOT EXISTS job_tombstones (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS presence (id TEXT PRIMARY KEY, data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS progress (job TEXT NOT NULL, seq INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job,seq));
    CREATE TABLE IF NOT EXISTS live_transcripts (attempt TEXT PRIMARY KEY, job TEXT NOT NULL, device TEXT NOT NULL, uploaded INTEGER NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS live_transcripts_uploaded ON live_transcripts(uploaded);
    CREATE INDEX IF NOT EXISTS live_transcripts_job ON live_transcripts(job);
    CREATE INDEX IF NOT EXISTS live_transcripts_device ON live_transcripts(device);
    -- Counters survive snapshot expiry: retention cannot reset an attempt's update budget or sequence.
    CREATE TABLE IF NOT EXISTS live_transcript_usage (attempt TEXT PRIMARY KEY, job TEXT NOT NULL, seq INTEGER NOT NULL, updates INTEGER NOT NULL, uploaded INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS live_transcript_usage_job ON live_transcript_usage(job);
    CREATE TABLE IF NOT EXISTS bootstrap_rates (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS bootstrap_rates_expiry ON bootstrap_rates(expires);
    CREATE INDEX IF NOT EXISTS nonces_expiry ON nonces(expires);
    CREATE INDEX IF NOT EXISTS idempotency_created ON idempotency(created);
    -- Response bytes and row counts are maintained transactionally, including expiry.
    CREATE TABLE IF NOT EXISTS idempotency_usage (device TEXT PRIMARY KEY, rows INTEGER NOT NULL, bytes INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS idempotency_usage_insert AFTER INSERT ON idempotency BEGIN
      INSERT INTO idempotency_usage VALUES('',1,length(CAST(NEW.response AS BLOB)))
        ON CONFLICT(device) DO UPDATE SET rows=rows+1,bytes=bytes+excluded.bytes;
      INSERT INTO idempotency_usage VALUES(NEW.device,1,length(CAST(NEW.response AS BLOB)))
        ON CONFLICT(device) DO UPDATE SET rows=rows+1,bytes=bytes+excluded.bytes;
    END;
    CREATE TRIGGER IF NOT EXISTS idempotency_usage_delete AFTER DELETE ON idempotency BEGIN
      UPDATE idempotency_usage SET rows=rows-1,bytes=bytes-length(CAST(OLD.response AS BLOB)) WHERE device IN ('',OLD.device);
      DELETE FROM idempotency_usage WHERE rows=0;
    END;
    CREATE TRIGGER IF NOT EXISTS idempotency_usage_update AFTER UPDATE ON idempotency BEGIN
      UPDATE idempotency_usage SET bytes=bytes-length(CAST(OLD.response AS BLOB))+length(CAST(NEW.response AS BLOB)) WHERE device IN ('',NEW.device);
    END;
    CREATE TABLE IF NOT EXISTS control_idempotency (device TEXT, key TEXT, request_digest TEXT NOT NULL, response TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(device,key));
    CREATE INDEX IF NOT EXISTS control_idempotency_created ON control_idempotency(created);
    -- Response bytes and row counts are maintained transactionally, including expiry.
    CREATE TABLE IF NOT EXISTS control_idempotency_usage (device TEXT PRIMARY KEY, rows INTEGER NOT NULL, bytes INTEGER NOT NULL);
    CREATE TRIGGER IF NOT EXISTS control_idempotency_usage_insert AFTER INSERT ON control_idempotency BEGIN
      INSERT INTO control_idempotency_usage VALUES('',1,length(CAST(NEW.response AS BLOB)))
        ON CONFLICT(device) DO UPDATE SET rows=rows+1,bytes=bytes+excluded.bytes;
      INSERT INTO control_idempotency_usage VALUES(NEW.device,1,length(CAST(NEW.response AS BLOB)))
        ON CONFLICT(device) DO UPDATE SET rows=rows+1,bytes=bytes+excluded.bytes;
    END;
    CREATE TRIGGER IF NOT EXISTS control_idempotency_usage_delete AFTER DELETE ON control_idempotency BEGIN
      UPDATE control_idempotency_usage SET rows=rows-1,bytes=bytes-length(CAST(OLD.response AS BLOB)) WHERE device IN ('',OLD.device);
      DELETE FROM control_idempotency_usage WHERE rows=0;
    END;
    CREATE TRIGGER IF NOT EXISTS control_idempotency_usage_update AFTER UPDATE ON control_idempotency BEGIN
      UPDATE control_idempotency_usage SET bytes=bytes-length(CAST(OLD.response AS BLOB))+length(CAST(NEW.response AS BLOB)) WHERE device IN ('',NEW.device);
    END;
    CREATE INDEX IF NOT EXISTS cursors_expiry ON cursors(json_extract(data,'$.expires'));
    `);
  } catch(error) {db.close();throw error;}
  // Keep the claim epoch internal; attempt wire records retain their v1 shape.
  if(!db.prepare('PRAGMA table_info(attempts)').all().some(column=>column.name==='claimed_epoch'))
    db.exec('ALTER TABLE attempts ADD COLUMN claimed_epoch INTEGER');
  const get = (table,id) => { const row=db.prepare('SELECT data FROM '+table+' WHERE id=?').get(String(id)); return row ? JSON.parse(row.data) : null; };
  const all = table => db.prepare('SELECT data FROM '+table).all().map(row=>JSON.parse(row.data));
  // Include permanent replay fences and short-code ownership in the same circle budget.
  const metadataTables=['rosters','invites','invite_codes','revoked_devices'];
  function installMetadataAccounting(){
    db.exec('CREATE TABLE IF NOT EXISTS circle_metadata_usage (id INTEGER PRIMARY KEY CHECK(id=1), rows INTEGER NOT NULL, bytes INTEGER NOT NULL)');
    if(!db.prepare('SELECT 1 FROM circle_metadata_usage WHERE id=1').get()){
      const usage=metadataTables.map(table=>db.prepare('SELECT count(*) AS rows,coalesce(sum(length(CAST(id AS BLOB))+length(CAST(data AS BLOB))),0) AS bytes FROM '+table).get());
      db.prepare('INSERT INTO circle_metadata_usage VALUES(1,?,?)').run(usage.reduce((n,u)=>n+u.rows,0),usage.reduce((n,u)=>n+u.bytes,0));
    }
    for(const table of metadataTables)db.exec(`
      CREATE TRIGGER IF NOT EXISTS ${table}_metadata_insert AFTER INSERT ON ${table} BEGIN
        UPDATE circle_metadata_usage SET rows=rows+1,bytes=bytes+length(CAST(new.id AS BLOB))+length(CAST(new.data AS BLOB)) WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_metadata_delete AFTER DELETE ON ${table} BEGIN
        UPDATE circle_metadata_usage SET rows=rows-1,bytes=bytes-length(CAST(old.id AS BLOB))-length(CAST(old.data AS BLOB)) WHERE id=1; END;
      CREATE TRIGGER IF NOT EXISTS ${table}_metadata_update AFTER UPDATE ON ${table} BEGIN
        UPDATE circle_metadata_usage SET bytes=bytes+length(CAST(new.data AS BLOB))-length(CAST(old.data AS BLOB)) WHERE id=1; END;`);
  }
  const metadataUsage=()=>db.prepare('SELECT rows,bytes FROM circle_metadata_usage WHERE id=1').get();
  function metadataLimits(ownerPublication){
    const limits=config.limits;
    // Ordinary writes leave enough space to replace a roster and revoke a delegate.
    return {rows:limits.circleMetadataRows-(ownerPublication?0:Math.min(1024,Math.max(1,Math.floor(limits.circleMetadataRows/4)))),
      bytes:limits.circleMetadataBytes-(ownerPublication?0:Math.min(1048576,Math.floor(limits.circleMetadataBytes/4)))};
  }
  function metadataBudget(before,ownerPublication){
    const usage=metadataUsage();
    // Old over-budget circles remain readable and can shrink without admitting more metadata.
    if(usage.rows<=before.rows&&usage.bytes<=before.bytes)return;
    const limits=metadataLimits(ownerPublication);
    need(usage.rows<=limits.rows&&usage.bytes<=limits.bytes,'quota_exceeded');
  }
  function collectRosterHistory({pressure=false,ownerPublication=true}={}){
    // An executor may sign with any epoch it observed while its attempt was active.
    const floor=db.prepare("SELECT min(coalesce(claimed_epoch,0)) AS epoch FROM attempts WHERE json_extract(data,'$.state')='active'").get().epoch;
    // Legacy active attempts have no recorded claim epoch: retain their history
    // conservatively until they finish. New attempts protect only their suffix.
    const unused=`CAST(id AS INTEGER) < ${floor??Number.MAX_SAFE_INTEGER} AND id != ?
      AND CAST(id AS INTEGER) NOT IN (SELECT json_extract(data,'$.signed.payload.roster_epoch') FROM jobs)
      AND CAST(id AS INTEGER) NOT IN (SELECT json_extract(data,'$.signed.payload.roster_epoch') FROM results)
      AND CAST(id AS INTEGER) NOT IN (SELECT json_extract(data,'$.approved_epoch') FROM enrollments WHERE json_extract(data,'$.approved_epoch') IS NOT NULL)`;
    const current=String(get('circle','config').epoch);
    db.prepare(`DELETE FROM rosters WHERE id NOT IN
      (SELECT id FROM rosters ORDER BY CAST(id AS INTEGER) DESC LIMIT ?) AND `+unused)
      .run(config.limits.rosterHistoryRows,current);
    if(pressure){
      const limits=metadataLimits(ownerPublication);
      for(;;){
        const usage=metadataUsage();if(usage.rows<=limits.rows&&usage.bytes<=limits.bytes)break;
        const old=db.prepare('SELECT id FROM rosters WHERE '+unused+' ORDER BY CAST(id AS INTEGER) LIMIT 1').get(current);
        if(!old)break;del('rosters',old.id);
      }
    }
  }
  const put = (table,id,value) => db.prepare('INSERT INTO '+table+'(id,data) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(String(id),JSON.stringify(value));
  const del = (table,id) => db.prepare('DELETE FROM '+table+' WHERE id=?').run(String(id));
  const now = () => { const t=clock(); need(Number.isSafeInteger(t)&&t>=0); return t; };
  let config,initial=false;
  try {
    db.exec('BEGIN IMMEDIATE');
    if(!get('circle','config')) {
      for(const {name} of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all())
        need(!db.prepare('SELECT 1 FROM "'+name.replaceAll('"','""')+'" LIMIT 1').get(),'conflict');
    }
    installMetadataAccounting();
    if(!get('circle','artifact_counts_v1')) {
      db.exec(`DELETE FROM artifact_counts;
        INSERT INTO artifact_counts SELECT json_extract(data,'$.uploader'),count(*),0 FROM artifacts GROUP BY json_extract(data,'$.uploader');
        INSERT INTO artifact_counts SELECT json_extract(data,'$.device'),0,count(*) FROM reservations GROUP BY json_extract(data,'$.device')
          ON CONFLICT(device) DO UPDATE SET reserved=excluded.reserved;
        INSERT INTO artifact_counts SELECT '',(SELECT count(*) FROM artifacts),(SELECT count(*) FROM reservations);`);
      put('circle','artifact_counts_v1',{installed:true});
    }
    // Rebuild once per accounting version, covering databases created before usage accounting.
    // The triggers keep the counters exact afterwards, so later opens skip the full scan.
    if(!get('circle','idempotency_usage_v1')) {
      db.exec(`DELETE FROM idempotency_usage;
        INSERT INTO idempotency_usage SELECT device,count(*),sum(length(CAST(response AS BLOB))) FROM idempotency GROUP BY device;
        INSERT INTO idempotency_usage SELECT '',count(*),sum(length(CAST(response AS BLOB))) FROM idempotency HAVING count(*)>0;`);
      put('circle','idempotency_usage_v1',{installed:true});
    }
    db.exec(`DELETE FROM control_idempotency_usage;
      INSERT INTO control_idempotency_usage SELECT device,count(*),sum(length(CAST(response AS BLOB))) FROM control_idempotency GROUP BY device;
      INSERT INTO control_idempotency_usage SELECT '',count(*),sum(length(CAST(response AS BLOB))) FROM control_idempotency HAVING count(*)>0;`);
    config=get('circle','config');
    if(!config) {
      initial=true;
      need(circle && rootFingerprint && origin && initialRoster);
      const signed=envelope(initialRoster);
      const verified=checked(p.verifyRoster(signed,{circle,rootFingerprint,now}));
      const signedLan = verified.payload.lan_mode === true;
      need(lanMode === undefined || (typeof lanMode === 'boolean' && lanMode === signedLan));
      // The roster's `coordinator` pins the incumbent host. A member store (owner-offline topology)
      // serves at its own origin, which the roster records on a member entry: that entry provisions it.
      const servesRecordedOrigin = verified.payload.members.some(member => member.origin === origin);
      if (signedLan) need(verified.payload.coordinator === origin || servesRecordedOrigin);
      if (verified.payload.coordinator !== undefined) need(verified.payload.coordinator === origin || servesRecordedOrigin);
      checked(p.validateOrigin(origin, { lanMode: signedLan }));
      const limits={...DEFAULT_LIMITS,...quotas};
      for(const value of Object.values(limits)) need(Number.isSafeInteger(value)&&value>=0);
      need(limits.maxArtifactBytes<=1073741824&&limits.concurrentUploads>=1);
      need(limits.terminalRetentionSeconds>=30*DAY&&limits.circleJobs>=1&&limits.nonceRows>=1&&limits.noncesPerDevice>=1);
      need(limits.deviceJobs>=1&&limits.maxJobLifetimeSeconds>=1);
      limits.deviceJobs=Math.min(limits.deviceJobs,Math.max(1,limits.circleJobs-1));
      config={circle,rootFingerprint,origin,lanMode:signedLan,epoch:verified.payload.epoch,limits};
      put('rosters',config.epoch,{signed,digest:verified.digest,bytes:p.canonicalize(signed)});
      put('circle','config',config);
    } else {
      for(const [key,value] of Object.entries({circle,rootFingerprint,origin})) if(value!==undefined) need(config[key]===value,'conflict');
      need(lanMode === undefined || lanMode === (config.lanMode === true),'conflict');
      checked(p.validateOrigin(config.origin, { lanMode: config.lanMode === true }));
      config.limits={...DEFAULT_LIMITS,...config.limits};
      config.limits.deviceJobs=Math.min(config.limits.deviceJobs,Math.max(1,config.limits.circleJobs-1));
      config.limits.terminalRetentionSeconds=Math.max(30*DAY,config.limits.terminalRetentionSeconds);
      put('circle','config',config);
    }
    if(!get('circle','queue_index_v1')) {
      for(const job of all('jobs'))saveJob(job);
      put('circle','queue_index_v1',{installed:true});
    }
    if(!get('circle','observed_attempt_accounting_v1')) {
      const attempts=db.prepare("SELECT data FROM attempts WHERE json_extract(data,'$.job_digest')=?");
      for(const job of all('jobs')) {
        job.attempts_started=attempts.all(job.job_digest).reduce((count,row)=>
          count+(typeof observedExecutionTime(JSON.parse(row.data))==='string'?1:0),0);
        saveJob(job);
      }
      put('circle','observed_attempt_accounting_v1',{installed:true});
    }
    collectRosterHistory();if(initial)metadataBudget({rows:0,bytes:0},true);
    db.exec('COMMIT');
  } catch(error) { try{db.exec('ROLLBACK');}catch{} db.close(); throw error; }
  const freshId = table => {
    const id=idGenerator();
    need(typeof id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id));
    need(!get(table,id),'conflict');return id;
  };
  const base=config.origin+'/v1/circles/'+config.circle;
  const jobRoute = digest => '/jobs/'+digest.slice(7);
  const artifactRoute = digest => '/artifacts/'+digest.slice(7);
  const roster = () => get('rosters',get('circle','config').epoch).signed.payload;
  const authMember = (device,r,t) => { need(seconds(r.valid_until)>t,'roster_expired'); const member=p.findMember(r,device); need(member,'forbidden'); return member; };
  function proof(ctx, method, route, body, t, {device, proposed, bootstrap, artifact, refresh=false}={}) {
    need(ctx && typeof ctx.proof==='string','unauthenticated');
    let request;
    try { request=p.strictParse(p.decodeBase64url(ctx.proof)).payload; } catch { fail('unauthenticated'); }
    device ??= request.key_id;
    need(device===request.key_id,'forbidden');
    let key,epoch;
    if(bootstrap) { key=bootstrap; need(p.fingerprint(key)===device,'forbidden'); epoch=0; }
    else { const r=proposed??roster(); key=authMember(device,r,t).public_key; epoch=r.epoch; if(refresh) {need(request.roster_epoch<=epoch,'roster_stale');epoch=request.roster_epoch;} }
    const read=method==='GET'||method==='HEAD';
    need(request.roster_epoch===epoch,'roster_stale');
    const bytes=read?Buffer.alloc(0):ctx.bodyBytes??Buffer.from(p.canonicalize(body));
    const expected={circle:config.circle,key_id:device,roster_epoch:epoch,method,target:base+(ctx.route??route),
      body_digest:artifact?.digest??p.digestBytes(bytes),content_length:artifact?.bytes??bytes.length,
      content_type:artifact?'application/octet-stream':read?'':'application/json',
      artifact_media_type:artifact?.media_type??'',idempotency_key:method==='POST'?request.idempotency_key:''};
    let rateLimited=false;
    const valid=p.verifyRequestProofSync(ctx.proof,{lanMode:config.lanMode===true,publicKey:key,expected,now:()=>t,consumeNonce:(id,nonce,expires)=>{
      const previous=db.prepare('SELECT expires FROM nonces WHERE device=? AND nonce=?').get(id,nonce);
      if(previous && previous.expires>t) return false;
      // A person's own actions keep their own share of this device's nonce budget: background reads stop at the
      // reserve, so a busy page can never use up the room a Send, Stop or Delete needs, including the reads those
      // actions make (judge r9 O-B, r10 R2). The device marks its own actions; it can only spend its own budget.
      const deviceLimit=read&&ctx?.personAction!==true?Math.max(1,config.limits.noncesPerDevice-Math.min(config.limits.writeNonceReserve??256,Math.floor(config.limits.noncesPerDevice/8))):config.limits.noncesPerDevice;
      if(db.prepare('SELECT count(*) AS n FROM nonces').get().n>=config.limits.nonceRows ||
        db.prepare('SELECT count(*) AS n FROM nonces WHERE device=?').get(id).n>=deviceLimit){rateLimited=true;return false;}
      db.prepare('INSERT INTO nonces(device,nonce,expires) VALUES(?,?,?) ON CONFLICT(device,nonce) DO UPDATE SET expires=excluded.expires').run(id,nonce,request.created+301);
      return true;
    }});
    need(!rateLimited,'rate_limited');checked(valid);
    return {device,request:valid.payload,identity:p.digest({method,target:expected.target,body_digest:expected.body_digest})};
  }
  const postSessions = new WeakMap();
  let transportCleanup,temporaryCleanup,inviteCodeRegistry;
  const reconcileInviteCode=code=>{
    if(!inviteCodeRegistry||typeof code!=='string'||!p.INVITE_CODE_PATTERN.test(code))return;
    if(get('invite_codes',code))inviteCodeRegistry.publish(code,config.circle);
    else inviteCodeRegistry.forget(code,config.circle);
  };
  // In-process retirement intents outlive unknown/failed database commits.
  // Startup recovery covers a process loss; maintenance covers a recovered DB.
  const abandonedUploads=new Map();
  function run(method,route,body,ctx,fn,options={}) {
    const session=options.session??postSessions.get(ctx);
    if(!options.session)postSessions.delete(ctx);
    try {db.exec('BEGIN IMMEDIATE');} catch {fail('unavailable');}
    let authenticated=false, savepoint=false, domainGarbage=0;
    const transactionGarbage=blobGarbage.length;
    try {
      const t=now();
      maintenance(t);
      let auth=session?.auth;
      if(auth) {
        const bytes=ctx.bodyBytes??Buffer.from(p.canonicalize(body));
        need(auth.request.method===method&&auth.identity===p.digest({method,target:base+(ctx.route??route),body_digest:p.digestBytes(bytes)}),'invalid_signature');
        if(options.device)need(options.device===auth.device,'forbidden');
        if(session.bootstrap) {
          need(auth.request.roster_epoch===0,'roster_stale');
          if(options.bootstrap)need(options.bootstrap===session.bootstrap,'forbidden');
        } else {
          authMember(auth.device,roster(),t);
          need(auth.request.roster_epoch===roster().epoch,'roster_stale');
          if(options.bootstrap)fail('roster_stale');
        }
        need(t-auth.request.created<=300,'unauthenticated');
      } else {
        auth=proof(ctx,method,route,body,t,options);
        if(session)session.auth=auth;
      }
      authenticated=true;
      const key=auth.request.idempotency_key;
      if(method==='POST') {
        // Both classes share the authenticated device/key namespace. Maintenance
        // has already removed expired entries; never let a key switch endpoints.
        const old=db.prepare('SELECT * FROM idempotency WHERE device=? AND key=?').get(auth.device,key)??
          db.prepare('SELECT * FROM control_idempotency WHERE device=? AND key=?').get(auth.device,key);
        if(old) {
          need(old.request_digest===auth.identity,'idempotency_conflict');
          if(session)session.replayed=true;
          const replay=JSON.parse(old.response);
          db.exec('COMMIT');authenticated=false;pruneAbandonedUploads();flushBlobGarbage();
          if(replay?.__error)fail(replay.__error);
          // Publication retries already supply these exact authenticated bytes.
          // Keep the original v1 response shape without retaining another copy.
          if(body?.payload?.schema==='faravan.job.v1'&&replay?.job_digest&&!replay.job)return {...replay,job:body};
          return replay;
        }
      }
      db.exec('SAVEPOINT domain'); savepoint=true;domainGarbage=blobGarbage.length;
      const metadataBefore=metadataUsage(),current=roster();
      const owner=current.authority_chain?.at(-1).payload.owner.key_id??p.fingerprint(current.root_public_key);
      const ownerPublication=method==='PUT'&&route==='/roster'&&(body.signature?.key_id===owner||body.signature?.key_id===body.payload?.authority_chain?.at(-1).payload.owner.key_id);
      const result=fn(auth.device,t);
      metadataBudget(metadataBefore,ownerPublication);
      need(!(result && typeof result.then==='function'),'internal_error');
      // Check the HTTP claim projection before committing any domain changes.
      const wire=result?.attempt&&result?.job?.job_digest?{job_digest:result.job.job_digest,job:result.job.job,attempt:result.attempt}:result;
      need(controlBytes(wire)<=responseLimit(ctx),'payload_too_large');
      // Also protect existing jobs admitted by older code or a larger cap.
      // Reject a transition atomically if its read/page projection cannot fit.
      const jobId=result?.job_digest??result?.job?.job_digest;
      const changedJob=method==='POST'&&jobId?get('jobs',jobId):null;
      if(changedJob)checkJobPage(view(changedJob,t),ctx);
      if(method==='POST' && !result?.__error && !(options.deferNull && result===null)) {
        const replay=jobId&&get('job_tombstones',jobId)?minimalJobReplay(result):result;
        const response=JSON.stringify(replay),bytes=Buffer.byteLength(response);
        // Only a final empty poll is control traffic. A successful claim, renewal,
        // progress update or other mutation retains its normal daily budget.
        const control=route==='/heartbeat'||(route==='/jobs/claim-next'&&result===null);
        const table=control?'control_idempotency':'idempotency',limit=control?'controlIdempotency':'idempotency';
        const usage=id=>db.prepare('SELECT rows,bytes FROM '+table+'_usage WHERE device=?').get(id)??{rows:0,bytes:0};
        const total=usage(''),device=usage(auth.device);
        need(total.rows<config.limits[limit+'Rows']&&device.rows<config.limits[limit+'RowsPerDevice']&&
          total.bytes+bytes<=config.limits[limit+'Bytes']&&device.bytes+bytes<=config.limits[limit+'BytesPerDevice'],'quota_exceeded');
        // Reject new keys at capacity without evicting unexpired replay fences.
        // A quota rejection rolls back domain changes; existing keys replay above.
        db.prepare('INSERT INTO '+table+'(device,key,request_digest,response,created) VALUES(?,?,?,?,?)')
          .run(auth.device,key,auth.identity,response,t);
      }
      db.exec('RELEASE domain'); savepoint=false; db.exec('COMMIT'); authenticated=false;pruneAbandonedUploads();flushBlobGarbage();
      if(result?.__error) fail(result.__error); return clone(result);
    } catch(error) {
      try {
        if(authenticated) { if(savepoint) {db.exec('ROLLBACK TO domain; RELEASE domain');blobGarbage.length=domainGarbage;} db.exec('COMMIT'); flushBlobGarbage(); }
        else {db.exec('ROLLBACK');blobGarbage.length=transactionGarbage;}
      } catch { try{db.exec('ROLLBACK');blobGarbage.length=transactionGarbage;}catch{} }
      if(error instanceof p.ProtocolError) throw error;
      throw new p.ProtocolError('internal_error');
    }
  }
  function verify(kind,signed,device) {
    signed=envelope(signed);
    const r=roster(),member=p.findMember(r,device); need(member,'forbidden');
    const result=checked(p.verifyEnvelope(kind,signed,member.public_key));
    checked(p.checkCircle(result.payload,config.circle));
    need(result.key_id===device,'forbidden');
    return {signed,...result};
  }
  // A start the coordinator authorized but never saw begin. Rows from before execution_observed_at count as observed.
  const unknownLaunch = a => typeof a.execution_started_at==='string'&&observedExecutionTime(a)==null;
  // Launch fence: such a start whose attempt ended without a result, before the holder reported its compute stopped.
  // It is derived from existing attempt fields, so the wire shape older clients check stays the same.
  const fenced = a => ['released','failed','expired','cancelled'].includes(a?.state)&&unknownLaunch(a)&&a.compute_stopped!==true;
  // The holder writes the launch ack only while its own lease is valid. The guest's wall backstop (docker-backend.mjs)
  // kills the agent's group at the sandbox deadline (set before the launch, so before lease end) plus the guard's stop
  // window (32 s), with no host process alive. One more full lease covers that window, the 60 s clock skew the store
  // accepts, and exec start-up. After this time the run cannot still be going, so the fence ends as a stop report would.
  // A stored wall limit outside the schema gives no bound: the fence then holds until proof or the job's deadline.
  // The backstop only kills the agent's process group. An escaped process can outlive this bound on a dead lender; it
  // then spends that lender's account until the lender restarts and recovery removes the sandbox (see docker-backend.mjs).
  const fenceBound = (a,job) => launchFenceBound(a,job);
  const fenceEnded = (a,job,t) => fenced(a)&&t>=fenceBound(a,job);
  function normalize(job,t,r=roster()) {
    job=clone(job);
    if(TERMINAL.has(job.state)) return job;
    const a=job.current_attempt?get('attempts',job.current_attempt):null;
    let reason=null,state=null;
    if(!p.findMember(r,job.author)) {job.state='cancelled'; reason='author_revoked';state='cancelled';}
    else if(job.expiry<=t) {job.state='expired';reason='job_expired';state='expired';}
    else if(a?.state==='active' && (!p.findMember(r,a.holder)||seconds(a.lease_expires_at)<=t)) {
      reason=!p.findMember(r,a.holder)?'holder_revoked':'lease_expired';
      state=reason==='holder_revoked'?'cancelled':'expired';
      // Launch fence: an authorized start that was never observed may still be running. The job stays claimed by this
      // attempt until the holder reports the run stopped or observed (resolveFence); its deadline still ends it.
      if(unknownLaunch(a)&&t<fenceBound(a,job)) {job.projected_attempt={...a,state,reason};return job;}
      // T21: once the agent started, a lost lease may have run it in part. It never requeues by itself; the borrower decides.
      job.state=typeof observedExecutionTime(a)==='string'||job.attempts_started>=job.max_attempts?'failed':'queued';
    }
    else if(job.state==='claimed'&&a&&fenceEnded(a,job,t)) {
      reason=a.reason;job.state=job.attempts_started>=job.max_attempts?'failed':'queued';
    }
    if(reason) {
      job.terminal_reason=reason;
      if(TERMINAL.has(job.state)) job.terminal_at??=job.state==='expired'?job.expiry:t;
      if(a?.state==='active') job.projected_attempt={...a,state,reason};
    }
    return job;
  }
  // GET /offers long-poll token: counts every change in which jobs are open (queued), so a watcher wakes on publish, release and
  // fail-before-start, and also learns an offer was taken or cancelled. Persisted so a restart never reuses a value.
  const offersRevision = () => get('circle','offers_revision')?.n??0;
  function saveJob(job) {
    if(job.projected_attempt) {put('attempts',job.projected_attempt.attempt_id,job.projected_attempt); delete job.projected_attempt;}
    put('jobs',job.job_digest,job);
    const wasQueued=db.prepare('SELECT ready FROM job_queue WHERE id=?').get(job.job_digest)?.ready===0;
    if(wasQueued!==(job.state==='queued'))put('circle','offers_revision',{n:offersRevision()+1});
    if(TERMINAL.has(job.state))db.prepare('DELETE FROM job_queue WHERE id=?').run(job.job_digest);
    else {
      const a=job.current_attempt?get('attempts',job.current_attempt):null;
      db.prepare('INSERT INTO job_queue(id,egress,ready,expiry,published,requirements) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET egress=excluded.egress,ready=excluded.ready,expiry=excluded.expiry,published=excluded.published,requirements=excluded.requirements')
        .run(job.job_digest,job.signed.payload.requirements.egress,job.state==='queued'?0:a.state==='active'?seconds(a.lease_expires_at):fenced(a)?Math.min(fenceBound(a,job),job.expiry):job.expiry,job.expiry,job.published_at,JSON.stringify(job.signed.payload.requirements));
    }
  }
  function maintenance(t) {
    // Always inside a write transaction; inclusive proof-age boundary
    // is retained until created+301, including proofs issued 60 seconds ahead.
    reconcileUploads();
    db.prepare('DELETE FROM live_transcripts WHERE uploaded<=?').run(t-TRANSCRIPT_RELAY_LIMITS.retentionSeconds);
    db.prepare('DELETE FROM nonces WHERE expires<=?').run(t);
    db.prepare('DELETE FROM idempotency WHERE created<=?').run(t-DAY);
    db.prepare('DELETE FROM control_idempotency WHERE created<=?').run(t-CONTROL_IDEMPOTENCY_SECONDS);
    db.prepare("DELETE FROM cursors WHERE json_extract(data,'$.expires')<=?").run(t);
    db.prepare('DELETE FROM bootstrap_rates WHERE expires<=?').run(t);
    for(const {id} of db.prepare('SELECT id FROM job_queue WHERE expiry<=?').all(t)) {
      const job=get('jobs',id);
      if(job)saveJob(normalize(job,t));
      else db.prepare('DELETE FROM job_queue WHERE id=?').run(id);
    }
    // Repair expired jobs normalized by older hosts at observation time.
    db.prepare(`UPDATE jobs SET data=json_set(data,'$.terminal_at',json_extract(data,'$.expiry'))
      WHERE json_extract(data,'$.state')='expired' AND json_extract(data,'$.terminal_at')>json_extract(data,'$.expiry')`).run();
    for(const {data} of db.prepare("SELECT data FROM jobs WHERE json_extract(data,'$.terminal_at')<=?").all(t-config.limits.terminalRetentionSeconds))retire(JSON.parse(data));
    // A hold lasts only while its job can still deliver; then the files return to normal collection.
    for(const {job,device} of db.prepare('SELECT DISTINCT job,device FROM delivery_holds').all())
      if(!openForDelivery(device,job,t))db.prepare('DELETE FROM delivery_holds WHERE job=?').run(job);
    // A bounded grace collector cannot race a live/uncertain upload of the same
    // digest. Job/result references are pinned in their publication transaction.
    for(const {id,data} of db.prepare(`SELECT a.id,a.data FROM artifacts a
      WHERE json_extract(a.data,'$.pinned')=0 AND json_extract(a.data,'$.created')<=?
      AND NOT EXISTS (SELECT 1 FROM reservations r WHERE json_extract(r.data,'$.ref.digest')=a.id)
      AND NOT EXISTS (SELECT 1 FROM delivery_holds h WHERE h.digest=a.id) LIMIT 128`)
      .all(t-config.limits.unreferencedArtifactGraceSeconds)) {
      const artifact=JSON.parse(data);adjust(artifact.uploader,-artifact.ref.bytes,0,0);
      del('artifacts',id);blobGarbage.push(id.slice(7));
    }
  }
  // P17a: a job's request, code, result, receipt and progress are deleted 30 days after it ends, files included; only a tombstone stays,
  // so a resubmitted envelope or a late retry still gets its original answer. Deleting it by hand (author or owner) goes the same way.
  const refsOfJob=job=>[job.signed?.payload?.source?.artifact?.digest,job.signed?.payload?.prompt?.digest].filter(Boolean);
  const refsOfResult=result=>[result?.signed?.payload?.candidate?.digest,result?.signed?.payload?.transcript?.digest].filter(Boolean);
  let blobGarbage=[],blobRemover=null;
  function flushBlobGarbage() {
    if(!blobRemover||!blobGarbage.length)return;
    const pending=blobGarbage;blobGarbage=[];
    for(const name of pending) {
      const digest='sha256:'+name;
      // A rolled-back collection or a later reupload can own this name again.
      // Cleanup retries must never unlink an artifact's new/current owner.
      if(get('artifacts',digest))continue;
      // A reservation only defers deletion: it may be released without ever
      // installing retained metadata, so keep the cleanup intent until it ends.
      if(db.prepare("SELECT 1 FROM reservations WHERE json_extract(data,'$.ref.digest')=? LIMIT 1").get(digest)) {
        blobGarbage.push(name);continue;
      }
      try{blobRemover(name);}catch{blobGarbage.push(name);} // retry after the next commit
    }
  }
  function collectArtifacts(digests) {
    if(!digests.size)return;
    const live=new Set();
    for(const {data} of db.prepare('SELECT data FROM jobs').all())for(const d of refsOfJob(JSON.parse(data)))live.add(d);
    for(const {data} of db.prepare('SELECT data FROM results').all())for(const d of refsOfResult(JSON.parse(data)))live.add(d);
    for(const digest of digests) {
      if(live.has(digest))continue; // another job still needs it
      const a=get('artifacts',digest);if(!a)continue;
      // A job still delivering a result that names this file keeps it. Unpinned, grace collection takes it once that job ends.
      if(db.prepare('SELECT 1 FROM delivery_holds WHERE digest=? LIMIT 1').get(digest)){a.pinned=false;put('artifacts',digest,a);continue;}
      adjust(a.uploader,-a.ref.bytes,0,0);db.prepare('DELETE FROM artifact_holders WHERE digest=?').run(digest);del('artifacts',digest);blobGarbage.push(digest.slice(7));
    }
  }
  function retire(job,deletion=null) {
    const result=get('results',job.job_digest),cancel=get('cancellations',job.job_digest),{job:ignored,...publish_ack}=job.publish_ack;
    put('job_tombstones',job.job_digest,{state:job.state,terminal_at:job.terminal_at,author:job.author,
      ...(job.signed.payload.audience?{audience:job.signed.payload.audience.device_keys}:{}),...(deletion?{deleted_by:deletion.by,deleted_at:deletion.at}:{}),
      envelope_digest:p.digest(job.signed),publish_ack,
      result:result?{envelope_digest:p.digest(result.signed),ack:result.ack,executor:result.signed.payload.executor}:null,
      cancellation:cancel?{envelope_digest:p.digest(cancel.signed),ack:cancel.ack}:null});
    // Publication keeps its acknowledgement; claims can no longer be executed.
    // Preserve device/key/request fences and creation times for both retries.
    for(const row of db.prepare(`SELECT device,key,response FROM idempotency
      WHERE json_type(response,'$.job')='object' AND
      (json_extract(response,'$.job_digest')=? OR json_extract(response,'$.job.job_digest')=?)`).all(job.job_digest,job.job_digest)) {
      db.prepare('UPDATE idempotency SET response=? WHERE device=? AND key=?')
        .run(JSON.stringify(minimalJobReplay(JSON.parse(row.response))),row.device,row.key);
    }
    db.prepare("DELETE FROM attempt_stop_requests WHERE id IN (SELECT id FROM attempts WHERE json_extract(data,'$.job_digest')=?)").run(job.job_digest);
    db.prepare("DELETE FROM attempts WHERE json_extract(data,'$.job_digest')=?").run(job.job_digest);
    db.prepare('DELETE FROM progress WHERE job=?').run(job.job_digest);
    db.prepare('DELETE FROM live_transcripts WHERE job=?').run(job.job_digest);
    db.prepare('DELETE FROM live_transcript_usage WHERE job=?').run(job.job_digest);
    db.prepare('DELETE FROM job_queue WHERE id=?').run(job.job_digest);
    db.prepare('DELETE FROM delivery_holds WHERE job=?').run(job.job_digest);
    del('results',job.job_digest);del('cancellations',job.job_digest);del('jobs',job.job_digest);
    collectArtifacts(new Set([...refsOfJob(job),...refsOfResult(result)]));
  }
  function minimalJobReplay(response) {
    if(!response?.job)return response;
    if(response.job.job_digest)return {__error:'job_terminal'};
    const {job,...ack}=response;return ack;
  }
  function eligibleJobs(ad,t) {
    // The egress/ready index excludes terminal, live-leased and unrelated queues.
    // SQL filters requirements before loading envelopes or verifying signatures. These are the blind claim-next paths: a job that
    // asks the lender to choose its model is only ever claimed by name, by a lender that has read the intent.
    return db.prepare(`SELECT q.id FROM job_queue q INDEXED BY job_queue_eligible
      WHERE q.egress IN (SELECT value FROM json_each(?)) AND q.ready<=? AND q.expiry>=?
      AND (json_type(q.requirements,'$.harness') IS NULL OR EXISTS (SELECT 1 FROM json_each(q.requirements,'$.harness') WHERE value IN (SELECT value FROM json_each(?))))
      AND (json_type(q.requirements,'$.model') IS NULL OR EXISTS (SELECT 1 FROM json_each(q.requirements,'$.model.any_of') WHERE value IN (SELECT value FROM json_each(?))))
      AND NOT EXISTS (SELECT 1 FROM json_each(q.requirements,'$.capabilities') WHERE value NOT IN (SELECT value FROM json_each(?)))
      AND NOT EXISTS (SELECT 1 FROM json_each(q.requirements,'$.limits') l
        WHERE COALESCE(json_extract(q.requirements,'$.limit_modes.'||l.key),'required')!='preferred'
        AND (l.key NOT IN (SELECT value FROM json_each(?)) OR l.value>json_extract(?, '$.'||l.key)))
      ORDER BY q.published,q.id`).all(JSON.stringify(ad.egress),t,t+30,JSON.stringify(ad.harnesses),JSON.stringify(ad.models),JSON.stringify(ad.capabilities),JSON.stringify(ad.enforced_limits),JSON.stringify(ad.max_limits));
  }
  // Presence (P1b). A lender that sends heartbeats is shown from them; an older lender is shown
  // from its last claim-next poll and is treated as having no new capabilities.
  function touchPoll(device,t) {
    const row=get('presence',device)??{};row.last_poll_at=t;put('presence',device,row);
  }
  function checkHeartbeat(body) {
    const text=(v,n)=>typeof v==='string'&&v.length>=1&&[...v].length<=n&&!/[\u0000-\u001f\u007f]/.test(v);
    const int=v=>v===null||(Number.isSafeInteger(v)&&v>=0);
    const list=(v,max,item)=>Array.isArray(v)&&v.length<=max&&v.every(item);
    const obj=(v,keys)=>v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).every(k=>keys.includes(k));
    // Capability declarations do not claim lending intent or online status.
    if(obj(body,['capabilities','profile'])&&Object.hasOwn(body,'capabilities')){
      if(body.profile!==undefined){need(obj(body.profile,['person_name','revision'])&&Object.keys(body.profile).length===2);p.checkDeviceName(body.profile.person_name);need(Number.isSafeInteger(body.profile.revision)&&body.profile.revision>=0);}
      need(list(body.capabilities,32,c=>typeof c==='string'&&/^[a-z0-9_]{1,40}$/.test(c))&&new Set(body.capabilities).size===body.capabilities.length);
      return;
    }
    need(obj(body,['boot','seq','intent','execution','blockers','agents','budget','schedule','capabilities','versions','accounts'])&&
      ['seq','intent','execution','blockers','agents','capabilities'].every(k=>Object.hasOwn(body,k)));
    need(Number.isSafeInteger(body.seq)&&body.seq>=0);
    need(body.boot===undefined||(typeof body.boot==='string'&&/^[A-Za-z0-9_-]{8,40}$/.test(body.boot)));
    need(obj(body.intent,['state','reason','until'])&&HEARTBEAT_INTENTS.includes(body.intent.state)&&
      (body.intent.reason==null||text(body.intent.reason,60))&&(body.intent.until==null||int(body.intent.until)));
    need(obj(body.execution,['state','stops_by'])&&HEARTBEAT_EXECUTIONS.includes(body.execution.state)&&(body.execution.stops_by==null||int(body.execution.stops_by)));
    need(list(body.blockers,16,b=>obj(b,['kind','agent'])&&text(b.kind,60)&&(b.agent===undefined||text(b.agent,60))));
    need(list(body.agents,8,a=>obj(a,['adapter','readiness','models','per_job_max_minutes','model_efforts'])&&text(a.adapter,60)&&
      ['ready','checking','unknown','signed_out','not_installed'].includes(a.readiness)&&list(a.models??[],16,m=>text(m,80))&&
      (a.per_job_max_minutes==null||int(a.per_job_max_minutes))));
    for(const agent of body.agents) if(Object.hasOwn(agent,'model_efforts')) {
      need(body.capabilities?.includes(MODEL_EFFORT_PAIRS_CAPABILITY));
      need(p.validateModelEffortPairs(agent.model_efforts,{models:agent.models??[],
        harnesses:[agent.adapter],harness:agent.adapter,maxModelLength:80}).ok);
    }
    // The choices an agent says it can make. Each one is a known choice, named once, and only with the capability and the pairs it is made from.

    // The accounts a lender can run a signed run request on: ids and descriptor model data only, and only with the capability.
    if(Object.hasOwn(body,'accounts'))need(body.capabilities?.includes(RUN_REQUEST_CAPABILITY)&&validateAccountAdvertisement(body.accounts));
    need(body.budget===undefined||body.budget===null||(obj(body.budget,['jobs_left_today','minutes_left_today','resets_at','time_zone'])&&
      int(body.budget.jobs_left_today??null)&&int(body.budget.minutes_left_today??null)&&int(body.budget.resets_at??null)&&(body.budget.time_zone==null||text(body.budget.time_zone,60))));
    need(body.schedule===undefined||body.schedule===null||(obj(body.schedule,['in_window','next_start','next_end'])&&
      (body.schedule.in_window==null||typeof body.schedule.in_window==='boolean')&&int(body.schedule.next_start??null)&&int(body.schedule.next_end??null)));
    need(list(body.capabilities,32,c=>typeof c==='string'&&/^[a-z0-9_]{1,40}$/.test(c))&&new Set(body.capabilities).size===body.capabilities.length);
    need(body.versions===undefined||body.versions===null||(obj(body.versions,['faravan','protocol','sbx'])&&Object.values(body.versions).every(v=>v==null||text(v,40))));
  }
  const PRESENCE_RANK={ready:6,starting:5,outside:4,resting:3,paused:2,blocked:1,update:1,off:0};
  function presenceView(t) {
    const members=roster().members,devices=members.map(m=>{
      const row=get('presence',m.key_id)??{},hb=row.heartbeat??null;
      const hbAge=hb?t-row.heartbeat_at:Infinity,pollAge=Number.isFinite(row.last_poll_at)?t-row.last_poll_at:Infinity;
      const fresh=hbAge<ONLINE_SECONDS,source=fresh?'heartbeat':pollAge<ONLINE_SECONDS?'poll':hb?'heartbeat':'none';
      return {device:m.key_id,person:p.personIdFor(m),online:fresh||pollAge<ONLINE_SECONDS,source,
        last_heartbeat_at:hb?iso(row.heartbeat_at):null,last_poll_at:Number.isFinite(row.last_poll_at)?iso(row.last_poll_at):null,
        intent:hb?.intent??null,execution:hb?.execution??null,blockers:hb?.blockers??[],agents:hb?.agents??[],
        budget:hb?.budget??null,schedule:hb?.schedule??null,
        // An older lender, or a stale heartbeat, claims no new capabilities.
        capabilities:fresh?hb.capabilities:[],versions:hb?.versions??null,
        // Keep the legacy top-level presence shape. Only current accepting
        // lenders expose anonymous model choices, never their account identity.
        ...(fresh&&hb.intent?.state==='ready'&&hb.capabilities.includes(RUN_REQUEST_CAPABILITY)?{
          account_offers:(hb.accounts??[]).flatMap(account=>account.models.filter(model=>model.enabled).map(model=>({
            providerId:account.providerId,modelId:model.id,effortIds:[...new Set(model.efforts.map(effort=>effort.id))]
          })))
        }:{}),
        ...(row.member_profile?{member_profile:row.member_profile}:{}),
        member_capabilities:row.member_capabilities??[],last_capabilities_at:row.capabilities_at===undefined?null:iso(row.capabilities_at)};
    });
    // Only verified person links group devices; an unsigned name cannot merge people.
    const persons=devices.map(d=>({person:d.person,online:d.online,
      able:d.online&&d.source==='heartbeat'&&d.intent?.state==='ready'||d.online&&d.source==='poll',
      status:d.online?(d.intent?.state??'ready'):'offline',devices:[d.device]}));
    const grouped=new Map();for(const person of persons){const old=grouped.get(person.person);if(old){old.online ||= person.online;old.able ||= person.able;old.devices.push(...person.devices);if(person.able)old.status=person.status;}else grouped.set(person.person,person);}
    return {now:iso(t),online_seconds:ONLINE_SECONDS,devices,persons:[...grouped.values()]};
  }
  // What a pre-results_v1 validator refuses with unsupported_version: a typed result or an empty-folder source.
  const needsResultsV1=payload=>payload.result!==undefined||payload.source?.kind==='none'||payload.requirements?.capabilities?.includes('results_v1')===true;
  const optionalListCapabilities=accepts=>['source_manifest_v1','source_project_name_v1','working_directory_v1','filtered_git_v1','auto_run_v1',RUN_REQUEST_CAPABILITY].filter(cap=>accepts.includes(cap));
  const canListJob=(payload,accepts)=>(!needsResultsV1(payload)||accepts.includes('results_v1'))&&
    (payload.requirements?.capabilities??[]).every(cap=>['patch-output','verify_v1'].includes(cap)||accepts.includes(cap));
  function view(job,t,declineCount=false) {
    job=normalize(job,t);
    return {job_digest:job.job_digest,job:job.signed,state:job.state,attempts_started:job.attempts_started,
      current_attempt:job.projected_attempt??(job.current_attempt?get('attempts',job.current_attempt):null),result_digest:job.result_digest??null,
      ...(declineCount?{declined_count:(job.declined_by??[]).length}:{})};
  }
  const loadJob = id => {
    const job=get('jobs',id);need(job,'not_found');
    // Legacy exclusions have no cause. Preserve them: attempt history cannot prove why a person declined.
    return job;
  };
  // Frozen audience: a job signed with payload.audience is visible only to the listed device keys. Every other device gets the
  // same not_found as for an unknown job, so nothing about it is disclosed. Without an audience every member sees it, as before.
  const visible = (job,device) => p.audienceAllows(job.signed.payload,device);
  const seeJob = (id,device) => {const job=loadJob(id);need(visible(job,device),'not_found');return job;};
  // Artifacts are shared by digest. A device may read one only through a job it may see that references it (as the prompt,
  // source, candidate or transcript), or after proving possession by uploading it.
  function artifactVisible(digest,device) {
    if(get('artifacts',digest)?.uploader===device||db.prepare('SELECT 1 FROM artifact_holders WHERE digest=? AND device=?').get(digest,device))return true;
    const audiences=db.prepare(`SELECT json_extract(data,'$.signed.payload.audience.device_keys') AS keys FROM jobs
        WHERE json_extract(data,'$.signed.payload.prompt.digest')=?1 OR json_extract(data,'$.signed.payload.source.artifact.digest')=?1
      UNION ALL SELECT json_extract(j.data,'$.signed.payload.audience.device_keys') FROM results r JOIN jobs j ON j.id=r.id
        WHERE json_extract(r.data,'$.signed.payload.candidate.digest')=?1 OR json_extract(r.data,'$.signed.payload.transcript.digest')=?1`)
      .all(digest).map(row=>row.keys===null?null:JSON.parse(row.keys));
    return audiences.some(keys=>keys===null||keys.includes(device));
  }
  function pin(ref,t,device) {
    refValid(ref); const a=get('artifacts',ref.digest); need(a,'artifact_missing');
    need(artifactVisible(ref.digest,device),'not_found');
    need(a.ref.bytes===ref.bytes&&a.ref.media_type===ref.media_type,'conflict');
    // General grace collection skips pinned metadata. Job retirement collects it
    // only after no retained job/result refers to the digest.
    a.pinned=true;a.pinned_at??=t;put('artifacts',ref.digest,a);
  }
  // The lease ended the run, but the same generation may still deliver the work it finished (see complete).
  const leaseLapsed=(job,a)=>job.state==='failed'&&job.terminal_reason==='lease_expired'&&
    ['active','expired'].includes(a.state)&&(!a.reason||a.reason==='lease_expired')&&
    job.current_attempt===a.attempt_id&&!get('cancellations',a.job_digest);
  // Can this device still deliver a result for the job: it holds the live attempt, or its lease lapsed and delayed delivery stands.
  function openForDelivery(device,id,t) {
    const raw=get('jobs',id);if(!raw)return false;
    const job=normalize(raw,t),a=job.current_attempt?get('attempts',job.current_attempt):null;
    if(!a||a.holder!==device)return false;
    if(job.state==='claimed')return a.state==='active';
    return leaseLapsed(job,a)&&!!p.findMember(roster(),job.author)&&!!p.findMember(roster(),device);
  }
  // Binds an upload to the job it delivers. Refused once the job cannot deliver; checked in the transaction that stores the bytes.
  function holdForDelivery(device,job,digest,t) {
    need(openForDelivery(device,job,t),'job_terminal');
    db.prepare('INSERT OR IGNORE INTO delivery_holds(digest,job,device) VALUES(?,?,?)').run(digest,job,device);
  }
  function historicalAuthor(job) {
    const old=get('rosters',job.signed.payload.roster_epoch);
    need(old && p.findMember(old.signed.payload,job.author),'forbidden');
    const member=p.findMember(old.signed.payload,job.author);
    checked(p.verifyEnvelope('job',job.signed,member.public_key));
    checked(p.checkAuthor(job.signed.payload,job.author));
    checked(p.checkCircle(job.signed.payload,config.circle));
  }
  /** True when this store's own origin is a member's recorded serving origin and not the incumbent coordinator's. */
  function servesMemberOrigin() {
    const r=roster();
    return r.coordinator!==config.origin&&r.members.some(member=>member.origin===config.origin);
  }
  /** Which store may dispatch a job (owner-offline topology), from the signed roster alone. Any store may
   *  retain or relay the signed bytes; only one may turn them into an attempt. A designated job is
   *  dispatched only for the member it names and, once that member's signed roster entry records a serving
   *  origin, only at that origin. An ordinary job is never dispatched by a store that serves a member's own
   *  origin: it stays with the incumbent authority. */
  function dispatchHere(payload,device) {
    const named=payload.designated_member;
    if(named===undefined)return !servesMemberOrigin();
    if(named!==device)return false;
    const at=p.findMember(roster(),named)?.origin;
    return at===undefined||at===config.origin;
  }
  function claim(device,id,advertisement,t,duration,skip=false) {
    need(p.circleWorkAllowed(roster(),device,'lend'),'forbidden');
    const original=loadJob(id);
    if(!visible(original,device)) {if(skip)return null;fail('not_found');}
    if(original.declined_by?.includes(device)) {if(skip)return null;fail('forbidden');}
    let job=normalize(original,t);
    if(JSON.stringify(job)!==JSON.stringify(original))saveJob(job);
    if(job.state!=='queued') {
      if(skip)return null;
      fail(job.state==='expired'?'job_expired':job.state==='failed'?'retry_exhausted':job.state==='claimed'?'conflict':'job_terminal');
    }
    // The dispatch fence (owner-offline topology): every store may hold a signed submission, but only the
    // authority it names may turn it into an attempt. A preserved job stays queued everywhere else.
    if(!dispatchHere(job.signed.payload,device))
      {if(skip)return null;fail('not_designated');}

    const r=roster(),deadline=Math.min(job.expiry,seconds(r.valid_until));
    if(!p.circleWorkAllowed(r,job.author,'borrow')){if(skip)return null;fail('forbidden');}
    if(deadline-t<30) {if(skip)return null;fail(job.expiry<=seconds(r.valid_until)?'job_expired':'roster_expired');}
    const payload=job.signed.payload;
    if(!p.canSatisfy(payload.requirements,advertisement,{job:payload}).ok) {if(skip)return null;fail('requirements_unsupported');}
    const valid=p.checkNewJob(payload);if(!valid.ok){if(skip)return null;checked(valid);}
    if(payload.runRequest!==undefined) {
      // A worker claims with its provider's complete current account list; other providers belong to their own workers.
      const presence=get('presence',device),hb=presence?.heartbeat;
      if(!hb||t-presence.heartbeat_at>ONLINE_SECONDS||!hb.capabilities.includes(RUN_REQUEST_CAPABILITY)||!hb.accounts||
          p.canonicalize(accountsForProviders(hb.accounts,(advertisement.accounts??[]).map(account=>account.providerId)))!==p.canonicalize(advertisement.accounts??null)||!resolveSelection({runRequest:payload.runRequest,accounts:advertisement.accounts}).ok&&
          resolveSelection({runRequest:payload.runRequest,accounts:advertisement.accounts}).code!=='account_busy') {
        if(skip)return null;fail('requirements_unsupported');
      }
    }
    if(job.signed.payload.budget_v1!==undefined){const presence=get('presence',device),hb=presence?.heartbeat;if(!hb||t-presence.heartbeat_at>90||!hb.capabilities.includes('budget_v1')){if(skip)return null;fail('requirements_unsupported');}}
    historicalAuthor(job);
    need(job.attempts_started<job.max_attempts,'retry_exhausted');
    need(Number.isSafeInteger(job.generation+1),'retry_exhausted');
    const a={attempt_id:freshId('attempts'),job_digest:id,generation:job.generation+1,holder:device,state:'active',
      claimed_at:iso(t),lease_expires_at:iso(Math.min(t+duration,deadline)),execution_started_at:null,execution_observed_at:null,reason:null,compute_stopped:false,stopped_at:null};
    need(!get('attempts',a.attempt_id),'conflict');
    job.generation=a.generation;job.current_attempt=a.attempt_id;job.state='claimed';
    put('attempts',a.attempt_id,a);
    if(payload.runRequest!==undefined){a.selection=resolveSelection({runRequest:payload.runRequest,accounts:advertisement.accounts}).value;put('attempts',a.attempt_id,a);}
    db.prepare('UPDATE attempts SET claimed_epoch=? WHERE id=?').run(r.epoch,a.attempt_id);
    saveJob(job);
    return {job:view(job,t),attempt:a};
  }
  // The only ways out of a launch fence. 'stopped': the holder sends /stopped only after its cleanup proved the sandbox
  // is gone, so the job may run elsewhere without spending a try. 'observed': the run happened, so T21 applies and the
  // job fails; a lease-expiry fence then keeps ship's delayed delivery of that run's result.
  function resolveFence(a,job,how,t) {
    if(TERMINAL.has(job.state)||job.current_attempt!==a.attempt_id)return false;
    job.state=how==='observed'||job.attempts_started>=job.max_attempts?'failed':'queued';
    job.terminal_reason=a.reason;if(TERMINAL.has(job.state))job.terminal_at=t;
    return true;
  }
  // Lenders before the launch fence (the .38 preview) accept lease_expired, not lease_fenced, when a release or stop
  // request is refused, and then check the job view. Those cleanup calls keep that code so the lenders reach /stopped.
  function active(device,id,generation,t,fenceCode='lease_fenced') {
    const a=get('attempts',id);need(a,'not_found');need(a.holder===device,'forbidden');
    need(a.generation===generation,'stale_attempt');
    const job=normalize(loadJob(a.job_digest),t);
    need(job.current_attempt===id&&job.generation===generation,'stale_attempt');
    need(!TERMINAL.has(job.state),job.state==='expired'?'job_expired':'job_terminal');
    need(!fenced(job.projected_attempt?.attempt_id===id?job.projected_attempt:a),fenceCode);
    need(a.state==='active','stale_attempt');need(seconds(a.lease_expires_at)>t,'lease_expired');
    need(job.state==='claimed','lease_expired');
    return {a,job};
  }
  function finishAttempt(device,id,generation,reason,t,state) {
    need(typeof reason==='string'&&[...reason].length>0&&[...reason].length<=4096);
    const {a,job}=active(device,id,generation,t,'lease_expired');
    a.state=state;a.reason=reason;
    let reasonCode,giveBackUntil;
    try {const parsed=JSON.parse(reason);reasonCode=parsed?.code;giveBackUntil=parsed?.until;} catch {}
    // A release or failure is not proof that an authorized launch never ran: fence it like a lost lease.
    if(unknownLaunch(a)) {
      put('attempts',id,a);
      if(state==='released'&&reasonCode==='approval_denied'&&!job.declined_by?.includes(device)) {
        job.declined_by_version=1;
        job.declined_by=[...(job.declined_by??[]).filter(key=>p.findMember(roster(),key)),device];
      }
      saveJob(job);return a;
    }
    put('attempts',id,a);
    // T21: an attempt that started the agent ends the job, whichever way it ends (released, failed): only an attempt that never
    // started is put back in the queue.
    job.state=job.expiry<=t?'expired':typeof observedExecutionTime(a)==='string'||job.attempts_started>=job.max_attempts?'failed':'queued';
    // Only a person's explicit refusal excludes a lender for the job's life. A setup failure, an isolation check included, is
    // bounded by the start-failure count below, so a repaired computer can take the job again.
    if(state==='released'&&job.state==='queued'&&reasonCode==='approval_denied'&&!job.declined_by?.includes(device)) {
      job.declined_by_version=1;
      job.declined_by=[...(job.declined_by??[]).filter(key=>p.findMember(roster(),key)),device];
      put('circle','offers_revision',{n:offersRevision()+1});
    }
    // A start that failed in the lender's own setup spends no run, so a job could cycle until it expires. It counts toward the
    // same cap as runs, and the job fails only when the count is reached AND a minimum time has passed since the first counted
    // failure: restarts alone cannot spend the attempts in minutes. The last attempt keeps the code of the last failure.
    if(state==='released'&&job.state==='queued'&&!Number.isSafeInteger(giveBackUntil)&&(reasonCode==='start_failed'||isStartFailure(reasonCode))) {
      job.start_failures=(job.start_failures??0)+1;
      job.first_start_failure_at??=t;
      if(job.start_failures>=job.max_attempts&&t-job.first_start_failure_at>=START_FAILURE_FLOOR_SECONDS)job.state='failed';
    }
    job.terminal_reason=reason;if(TERMINAL.has(job.state))job.terminal_at=t;saveJob(job);return a;
  }
  const counter = id => get('quota_counters',id)??{retained_bytes:0,reserved_bytes:0,uploads:0};
  function adjust(device,retained,reserved,uploads) {
    for(const key of ['circle','device:'+device]) {
      const q=counter(key);q.retained_bytes+=retained;q.reserved_bytes+=reserved;q.uploads+=uploads;
      need(Object.values(q).every(n=>Number.isSafeInteger(n)&&n>=0),'internal_error');put('quota_counters',key,q);
    }
  }
  function releaseReservation(reservation,settled=false) {
    need(settled||(!reservation.install_pending&&!reservation.owner_live&&!reservation.temp_name),'conflict');
    adjust(reservation.device,0,-reservation.ref.bytes,-1);del('reservations',reservation.reservation_id);
  }
  function uploadReservation(device,id,actual,ownerToken) {
    const r=get('reservations',id);need(r&&r.device===device,'not_found');
    need(!r.transport||(r.owner_live&&typeof ownerToken==='string'&&r.owner_token===ownerToken),'conflict');
    const current=roster();authMember(device,current,now());
    need(r.roster_epoch===current.epoch,'roster_stale');refValid(actual);
    need(actual.digest===r.ref.digest,'digest_mismatch');need(actual.bytes===r.ref.bytes,'size_mismatch');
    need(actual.media_type===r.ref.media_type,'conflict');
    const old=get('artifacts',actual.digest);
    if(old)need(p.canonicalize(old.ref)===p.canonicalize(actual),'conflict');
    return {r,old};
  }

  function settleUpload(r,cleanup) {
    // Digest and size identify the permanent bytes already covered by retained
    // metadata. Media type still conflicts for live requests, but cannot strand
    // an inactive charge. Never settle a live owner or an unremoved temporary.
    if(r.owner_live||r.temp_name)return false;
    const old=get('artifacts',r.ref.digest);
    // Non-transport reservations have no owner_live flag; their caller owns
    // the bytes until explicitly committing or releasing the reservation.
    const sharedLive=all('reservations').some(other=>other.reservation_id!==r.reservation_id&&other.ref.digest===r.ref.digest&&(!other.transport||other.owner_live));
    if(!r.install_pending||(old&&old.ref.digest===r.ref.digest&&old.ref.bytes===r.ref.bytes)||
       (!old&&!sharedLive&&cleanup?.(r.ref)===true)) {
      releaseReservation(r,true);return true;
    }
    return false;
  }
  function pruneAbandonedUploads() {
    // Call only after a confirmed COMMIT: reconciliation can run more than
    // once in one transaction, and its changes may otherwise still roll back.
    try {
      for(const [token,intent] of abandonedUploads) {
        const r=intent.id?get('reservations',intent.id):all('reservations').find(row=>row.owner_token===token);
        if(!r||r.owner_token!==token||!r.owner_live)abandonedUploads.delete(token);
      }
    } catch { /* A later confirmed transaction can prune these intents. */ }
  }
  function reconcileAbandonedUploads() {
    for(const [token,intent] of abandonedUploads) {
      const r=intent.id?get('reservations',intent.id):all('reservations').find(row=>row.owner_token===token);
      if(!r||!r.transport||r.owner_token!==token||r.device!==intent.device||!r.owner_live) {
        continue;
      }
      r.owner_live=false;
      if(intent.temporaryRemoved)delete r.temp_name;
      const cleanup=ref=>{try{return intent.cleanup?.(ref);}catch{return false;}};
      if(!settleUpload(r,cleanup))put('reservations',r.reservation_id,r);
    }
  }
  function reconcileUploads(digest) {
    reconcileAbandonedUploads();
    for(const r of all('reservations'))if(r.transport&&!r.owner_live&&(!digest||r.ref.digest===digest)) {
      try {if(r.temp_name&&temporaryCleanup?.(r.temp_name)===true)delete r.temp_name;}
      catch { /* Retry failed temporary cleanup on the next maintenance pass. */ }
      const cleanup=ref=>{try{return transportCleanup?.(ref,{abandonedAtStartup:r.abandoned_at_startup===true});}catch{return false;}};
      if(!settleUpload(r,cleanup))put('reservations',r.reservation_id,r);
    }
  }
  function verifyEnrollmentInvite(body) {
    need(body&&typeof body==='object'&&!Array.isArray(body));
    const supplied=envelope(body.invite),invite=get('invites',supplied.payload.invite_id);
    need(invite,'not_found');need(!invite.revoked_at,'enrollment_rejected');need(invite.bytes===p.canonicalize(supplied),'enrollment_conflict');
    // Check bootstrap authority before either first-use or replay authentication
    // can retain a nonce on an invalid invite-key proof.
    checked(p.verifyEnrollmentProof(body.enrollment_proof,{invitePublicKey:invite.signed.payload.invite_public_key,
      circle:config.circle,invite_id:supplied.payload.invite_id,device_public_key:body.device_public_key}));
  }
  const api={
    close() { db.close(); },
    collect() {
      try {db.exec('BEGIN IMMEDIATE');}catch{fail('unavailable');}
      const garbageBefore=blobGarbage.length;
      try {maintenance(now());db.exec('COMMIT');}
      catch(error) {db.exec('ROLLBACK');blobGarbage.length=garbageBefore;throw error;}
      pruneAbandonedUploads();flushBlobGarbage();
    },
    configuration() { return clone(config); },
    // Durable membership for reconciling transport reads after uncertain writes.
    currentMemberKeys() { return roster().members.map(member=>member.key_id); },
    versionPolicy() { return {minMember,faravanVersion}; },
    getRoster(device,ctx) {return run('GET','/roster',null,ctx,()=>get('rosters',get('circle','config').epoch).signed,{device,refresh:true});},
    getHistoricalRoster(device,epoch,ctx) {
      need(Number.isSafeInteger(epoch)&&epoch>=1);
      return run('GET','/rosters/'+epoch,null,ctx,()=>{const r=get('rosters',epoch);need(r,'not_found');return r.signed;},{device,refresh:true});
    },
    preflightRequest(device,ctx) {
      const request=p.strictParse(p.decodeBase64url(ctx.proof)).payload,t=now(),r=roster();
      need(request.key_id===device,'forbidden');
      const {schema,created,nonce,lan_mode,...declared}=request;
      if(request.roster_epoch===0&&request.method==='GET'&&ctx.route?.startsWith('/enrollments/')) {
        const e=get('enrollments',ctx.route.slice('/enrollments/'.length));need(e&&e.device===device,'not_found');
        checked(p.verifyRequestProofSync(ctx.proof,{lanMode:config.lanMode===true,publicKey:e.device_public_key,expected:{...declared,circle:config.circle,target:base+ctx.route},now:()=>t,consumeNonce:()=>true}));return request;
      }
      const member=p.findMember(r,device);
      const enrollmentBootstrap=ctx.route==='/enrollments'&&request.method==='POST';
      if(enrollmentBootstrap||ctx.route==='/roster'&&request.method==='PUT'&&!member) {
        // Bootstrap public keys arrive in the body. Reject malformed envelopes
        // before the transport assigns its separate body-reading allowance.
        const signed=p.strictParse(p.decodeBase64url(ctx.proof));
        need(Object.keys(signed).length===2&&signed.signature&&typeof signed.signature==='object','unauthenticated');
        const signature=signed.signature;
        need(Object.keys(signature).length===3&&signature.algorithm==='Ed25519'&&signature.key_id===device,'unauthenticated');
        try{p.decodeBase64url(signature.value,64);}catch{fail('unauthenticated');}
        const required=['schema','circle','key_id','roster_epoch','method','target','body_digest','content_length','content_type','artifact_media_type','idempotency_key','created','nonce'];
        need(required.every(key=>Object.hasOwn(request,key))&&Object.keys(request).every(key=>required.includes(key)||key==='lan_mode'),'unauthenticated');
        need(request.schema==='faravan.request.v1'&&typeof device==='string'&&/^sha256:[0-9a-f]{64}$/.test(device)&&typeof request.body_digest==='string'&&/^sha256:[0-9a-f]{64}$/.test(request.body_digest),'unauthenticated');
        need(Number.isSafeInteger(request.roster_epoch)&&request.roster_epoch>=0&&Number.isSafeInteger(request.created)&&t-request.created<=300&&request.created-t<=60,'unauthenticated');
        need(request.circle===config.circle&&request.target===base+ctx.route&&request.content_type==='application/json'&&request.artifact_media_type===''&&(enrollmentBootstrap?isOperationKey(request.idempotency_key):request.idempotency_key===''),'unauthenticated');
        need((request.lan_mode===true)===(config.lanMode===true)&&(request.lan_mode===undefined||request.lan_mode===true),'unauthenticated');
        need(Number.isSafeInteger(request.content_length)&&request.content_length>=0&&request.content_length<=MAX_CONTROL_BYTES,'unauthenticated');
        let nonce;try{nonce=p.decodeBase64url(request.nonce);}catch{fail('unauthenticated');}
        need(nonce.length>=16&&nonce.length<=64,'unauthenticated');
        return {...request,rosterRecovery:!enrollmentBootstrap,enrollmentBootstrap};
      }
      const key=(ctx.route==='/roster'&&request.method==='PUT'?member:authMember(device,r,t)).public_key;
      const refresh=ctx.route==='/roster'||ctx.route?.startsWith('/rosters/');
      if(request.method!=='PUT'||ctx.route!=='/roster')need(refresh?request.roster_epoch<=r.epoch:request.roster_epoch===r.epoch,'roster_stale');
      checked(p.verifyRequestProofSync(ctx.proof,{lanMode:config.lanMode===true,publicKey:key,expected:{...declared,circle:config.circle,target:base+ctx.route},now:()=>t,consumeNonce:()=>true}));
      return request;
    },
    // Authenticate/consume a POST nonce and resolve its device/key namespace
    // before transport endpoint validation. The continuation never crosses HTTP.
    openPostRequest(device,body,ctx) {
      const request=p.strictParse(p.decodeBase64url(ctx.proof)).payload;
      const session={};
      if(request.roster_epoch===0&&ctx.route==='/enrollments') {
        verifyEnrollmentInvite(body);
        const existing=all('enrollments').find(e=>e.device===device);
        // A first enrollment has no successful key to replay. Preserve the
        // invite existence gate before allocating any bootstrap nonce rows.
        if(!existing)return {replayed:false,result:null};
        session.bootstrap=existing.device_public_key;
      }
      const result=run('POST',ctx.route,body,ctx,()=>null,{device,session,deferNull:true,
        ...(session.bootstrap?{bootstrap:session.bootstrap}:{})});
      postSessions.set(ctx,session);
      if(session.replayed&&ctx.route==='/invites')reconcileInviteCode(body?.code);
      return {replayed:session.replayed===true,result};
    },
    getCapabilities(device,ctx) {return run('GET','/capabilities',null,ctx,()=>({
      protocol:'1.0',circle:config.circle,root_fingerprint:config.rootFingerprint,roster_epoch:roster().epoch,
      lease:{min_seconds:30,default_seconds:120,max_seconds:300},max_claim_wait_seconds:30,max_page_size:100,max_attempts:3,
      idempotency_retention_seconds:DAY,control_idempotency_retention_seconds:CONTROL_IDEMPOTENCY_SECONDS,terminal_retention_seconds:config.limits.terminalRetentionSeconds,roster_max_lifetime_seconds:30*DAY,
      max_artifact_bytes:config.limits.maxArtifactBytes,device_storage_quota_bytes:config.limits.deviceBytes,
      circle_storage_quota_bytes:config.limits.circleBytes,max_json_bytes:262144,
      supported_capabilities:['patch-output','verify_v1','budget_v1'],supported_egress:['provider-only','internet'],input_protection:['none'],
      archive_policy:{max_entries:100000,max_expanded_bytes:10737418240,max_depth:64,max_path_bytes:4096},
      max_concurrent_uploads_per_device:config.limits.concurrentUploads,artifact_head:true,
      // P22: this host's Faravan version, the oldest member it works with, and what it can do (null when unknown or unset).
      faravan:isVersion(faravanVersion)?faravanVersion:null,min_member:isVersion(minMember)?minMember:null,capabilities:[...HOST_CAPABILITIES]
    }),{device});},
    // A one-request capability: authenticate/consume nonce once, then recheck
    // current membership/epoch and proof age on every wake. No network endpoint
    // accepts this continuation, and no no-work outcome is cached before timeout.
    openClaimPoll(device,body,ctx) {
      const session=postSessions.get(ctx)??{};postSessions.delete(ctx);let closed=false;
      const poll=(final=false)=>{
        need(!closed,'invalid_request');
        return run('POST','/jobs/claim-next',body,ctx,(_,t)=>{
          touchPoll(device,t);
          const duration=leaseDuration(body.lease_seconds===undefined?120:body.lease_seconds);advertisementValid(body.advertisement);
          const excluded=exclusions(body.exclude);
          for(const job of eligibleJobs(body.advertisement,t)) {
            if(excluded.has(job.id))continue;
            const result=claim(device,job.id,body.advertisement,t,duration,true);if(result)return result;
          }
          return null;
        },{device,session,deferNull:!final});
      };
      const initial=poll();
      return {initial,replayed:session.replayed===true,poll,close(){closed=true;}};
    },
    // Private transport lifecycle, usable only with an already authenticated
    // reservation. IO is installed synchronously within the commit transaction.
    trackArtifactUpload(device,id,ownerToken,tempName) {
      const r=get('reservations',id);need(r&&r.device===device,'not_found');
      need(r.transport&&r.owner_live&&r.owner_token===ownerToken&&!r.temp_name,'conflict');
      need(typeof tempName==='string'&&/^\.upload-[0-9a-f-]{36}$/.test(tempName));
      // Persist the cleanup identity before opening or writing any temporary bytes.
      r.temp_name=tempName;put('reservations',id,r);
    },
    finishArtifactUpload(device,id,actual,install,ownerToken,{verifiedInput=false,job}={}) {
      try {
        if(job)need(openForDelivery(device,job,now()),'job_terminal');
        uploadReservation(device,id,actual,ownerToken);
        // Autocommit this marker before any filesystem installation. A crash
        // or unknown COMMIT outcome must leave durable quota ownership behind.
        need(db.prepare("UPDATE reservations SET data=json_set(data,'$.install_pending',json('true')) WHERE id=?")
          .run(id).changes===1,'not_found');
        db.exec('BEGIN IMMEDIATE');
        const {r,old}=uploadReservation(device,id,actual,ownerToken);
        if(job)holdForDelivery(device,job,actual.digest,now());
        need(!old||verifiedInput||artifactVisible(actual.digest,device),'conflict');
        install();releaseReservation(r,true);
        if(!old){adjust(device,actual.bytes,0,0);put('artifacts',actual.digest,{ref:actual,uploader:device,created:now(),pinned:false});}
        if(verifiedInput)db.prepare('INSERT OR IGNORE INTO artifact_holders(digest,device) VALUES(?,?)').run(actual.digest,device);
        reconcileUploads(actual.digest);
        db.exec('COMMIT');pruneAbandonedUploads();return actual;
      } catch(error){try{db.exec('ROLLBACK');}catch{}
        throw error instanceof p.ProtocolError?error:new p.ProtocolError('internal_error');
      }
    },
    recoverTransportUploads(cleanup,cleanupTemporary) {
      // The transport must hold its exclusive process lock and remove legacy
      // orphan temporaries before declaring previous request owners inactive.
      transportCleanup=cleanup;temporaryCleanup=cleanupTemporary;
      db.exec('BEGIN IMMEDIATE');
      try {
        for(const r of all('reservations'))if(r.transport) {
          r.owner_live=false;r.abandoned_at_startup=true;delete r.retrying;put('reservations',r.reservation_id,r);
        }
        reconcileUploads();
        db.exec('COMMIT');
      } catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
    },
    abortArtifactUpload(device,id,cleanup,ownerToken,temporaryRemoved=false) {
      if(typeof ownerToken==='string')abandonedUploads.set(ownerToken,{device,id,cleanup,temporaryRemoved});
      db.exec('BEGIN IMMEDIATE');
      let cleanupError;
      try {
        const r=get('reservations',id);
        if(r) {
          need(r.device===device,'forbidden');
          // A delayed abort from an older request cannot change ownership or
          // invoke cleanup on a newer request's reservation.
          if(!r.transport||(typeof ownerToken==='string'&&r.owner_token===ownerToken)) {
            r.owner_live=false;
            if(temporaryRemoved)delete r.temp_name;
            const verifiedCleanup=ref=>{try{return cleanup?.(ref);}catch(error){cleanupError=error;return false;}};
            if(!settleUpload(r,verifiedCleanup))put('reservations',id,r);
          }
        }
        db.exec('COMMIT');
      } catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}
      abandonedUploads.delete(ownerToken);pruneAbandonedUploads();
      if(cleanupError)throw cleanupError;
    },
    installRoster(signed,ctx) {
      signed=envelope(signed);
      // Verification here chooses the proposed authentication key; anti-rollback is
      // repeated under BEGIN IMMEDIATE before any domain state changes.
      const proposed=checked(p.verifyRoster(signed,{circle:config.circle,rootFingerprint:config.rootFingerprint,now})).payload;
      need((proposed.lan_mode === true) === (config.lanMode === true), 'conflict');
      // The roster's canonical coordinator is the incumbent host identity; a member store's own origin
      // is an HTTP proof target the roster records on a member entry. An ordinary store is its own
      // coordinator, so the pin stays exact; a store that serves a recorded member origin accepts the
      // roster that continues to name it, whatever incumbent the roster carries.
      const servesRecordedOrigin = proposed.members.some(member => member.origin === config.origin);
      if (config.lanMode || proposed.coordinator !== undefined)
        need(proposed.coordinator === config.origin || servesRecordedOrigin, 'conflict');
      const canonicalCoordinator = servesRecordedOrigin ? (proposed.coordinator ?? roster().coordinator) : config.origin;
      return run('PUT','/roster',signed,ctx,(device,t)=>{
        const old=roster(),verified=checked(p.verifyRoster(signed,{circle:config.circle,rootFingerprint:config.rootFingerprint,now:()=>t,
          highestAcceptedEpoch:old.epoch,highestAcceptedDigest:get('rosters',old.epoch).digest,previousAuthorityChain:old.authority_chain,previousRoster:old,requireCurrentLinkEpoch:true}));
        if(old.governance){
          need(proposed.governance,'forbidden');
          if(!proposed.authority_chain||p.canonicalize(proposed.authority_chain)===p.canonicalize(old.authority_chain??null))need(proposed.governance.owner_person===old.governance.owner_person,'forbidden');
          if(old.governance.state==='closed')need(proposed.governance.state==='closed','forbidden');
        }
        let authority;
        if(proposed.authority_chain){
          authority=checked(p.chainVerify(proposed.authority_chain,{circle:config.circle,rootFingerprint:config.rootFingerprint,coordinator:canonicalCoordinator,previousChain:old.authority_chain,now:t,requireFreshTransfer:true})).authority;
          for(const key of [authority.owner,authority.steward,...(authority.admins??[])].filter(Boolean))need(p.findMember(proposed,key.key_id),'forbidden');
          if(proposed.governance)need(proposed.governance.owner_person===p.personIdFor(p.findMember(proposed,authority.owner.key_id)),'forbidden');
          const prior=old.authority_chain&&checked(p.chainVerify(old.authority_chain,{circle:config.circle,rootFingerprint:config.rootFingerprint,coordinator:canonicalCoordinator})).authority;
          const unchanged=old.authority_chain&&p.canonicalize(old.authority_chain)===p.canonicalize(proposed.authority_chain);
          if(unchanged&&signed.signature.key_id!==authority.owner.key_id){
            if(proposed.governance?.state==='closed')need(old.governance?.state==='closed','forbidden');
            // Delegates manage ordinary membership and settings; only the owner changes authority or roles.
            need((old.governance?.owner_person??null)===(proposed.governance?.owner_person??null),'forbidden');
            for(const person of old.governance?.people??[]){const next=proposed.governance?.people.find(x=>x.person_id===person.person_id);if(next)need(next.role===person.role,'forbidden');}
            for(const key of [prior.owner,prior.steward,...(prior.admins??[])].filter(Boolean)){
              const before=p.findMember(old,key.key_id),after=p.findMember(proposed,key.key_id);need(after&&p.personIdFor(after)===p.personIdFor(before),'forbidden');
              need(!proposed.governance?.people.find(x=>x.person_id===p.personIdFor(after))?.blocked,'forbidden');
            }
          }
          if(!unchanged)for(const row of db.prepare('SELECT id,data FROM invites').all()) {
            // A revoke may precede publication, leaving an unsigned tombstone.
            const invite=JSON.parse(row.data);invite.revoked_at??=iso(t);put('invites',row.id,invite);
          }
        }
        const bytes=p.canonicalize(signed);
        if(proposed.epoch===old.epoch) {need(bytes===get('rosters',old.epoch).bytes,'roster_stale');return signed;}
        const requiredCapabilities=changedMembershipCapabilities(old,proposed);
        // Nonrestrictive changes still negotiate under the installation transaction.
        // Removals and blocks cannot be vetoed by capability declarations.
        // As with profile edits, the publisher demonstrates support by signing.
        need(old.members.every(member=>member.key_id===device||requiredCapabilities.every(capability=>
          get('presence',member.key_id)?.member_capabilities?.includes(capability))),'circle_members_need_update');
        for(const member of proposed.members) {
          need(!get('revoked_devices',member.key_id),'forbidden');
          if(p.findMember(old,member.key_id))continue;
          // An owner may add a key directly. A key that asked to join through an
          // invitation is admitted only while one of its requests is still live:
          // revoking the invitation or rejecting the request fences a roster the
          // owner signed earlier but had not yet published.
          const requests=all('enrollments').filter(e=>e.device===member.key_id);
          // The roster names no request, so it must also postdate every request that ended: a roster signed
          // before one was declined, revoked or expired must not be revived by a different pending request.
          if(requests.length) {
            need(requests.some(e=>e.state==='pending'&&e.expires>t&&e.device_public_key===member.public_key&&
              !get('invites',e.invite_id)?.revoked_at),'forbidden');
            for(const e of requests) {
              const revoked=get('invites',e.invite_id)?.revoked_at;
              const ended=e.state==='rejected'||e.state==='expired'?e.ended??e.expires:revoked?seconds(revoked):e.state==='pending'&&e.expires<=t?e.expires:null;
              need(ended===null||seconds(proposed.issued_at)>ended,'forbidden');
            }
          }
        }
        for(const member of old.members) if(!p.findMember(proposed,member.key_id))put('revoked_devices',member.key_id,{epoch:proposed.epoch});
        put('rosters',proposed.epoch,{signed,digest:verified.digest,bytes});
        // Delegated publications keep the owner from verified authority, not the publishing admin. A legacy
        // (chainless) install on an ordinary store records its authenticated owner device. A store serving a
        // recorded member origin is reached by carriers that are not the owner, so it never promotes the
        // carrier: it keeps the independent owner it already holds, and an unknown owner stays unknown.
        const c=get('circle','config');c.epoch=proposed.epoch;
        const owner=authority?.owner.key_id??(servesRecordedOrigin?c.owner_device:device);
        if(owner)c.owner_device=owner;
        put('circle','config',c);
        collectRosterHistory({pressure:true,ownerPublication:signed.signature.key_id===(authority?.owner.key_id??p.fingerprint(proposed.root_public_key))});
        for(const job of all('jobs'))saveJob(normalize(job,t,proposed));
        for(const reservation of all('reservations'))if(!reservation.transport&&!reservation.install_pending&&!p.findMember(proposed,reservation.device))releaseReservation(reservation);
        // A leave request is done once its device is no longer a member.
        for(const l of all('leave_requests'))if(!p.findMember(proposed,l.key_id))del('leave_requests',l.key_id);
        for(const m of all('member_origins'))if(!p.findMember(proposed,m.key_id))del('member_origins',m.key_id);
        for(const e of all('enrollments')) {
          if(e.state==='approved'&&!p.findMember(proposed,e.device)) {e.state='rejected';put('enrollments',e.enrollment_id,e);}
          if(e.state!=='pending')continue;
          if(e.expires<=t)e.state='expired';
          else if(p.findMember(proposed,e.device)) {e.state='approved';e.approved_epoch=proposed.epoch;}
          put('enrollments',e.enrollment_id,e);
        }
        return signed;
      },{proposed});
    },
    publishJob(signed,ctx) {
      signed=envelope(signed);
      return run('POST','/jobs',signed,ctx,(device,t)=>{
        need(p.circleWorkAllowed(roster(),device,'borrow'),'forbidden');
        const v=verify('job',signed,device),payload=v.payload;
        checked(p.checkNewJob(payload));checked(p.checkAuthor(payload,device));
        // The borrower may name the one member whose store may dispatch this job (owner-offline
        // topology). The name must be a current member at publish; every member store can still hold it.
        if(payload.designated_member!==undefined)need(p.findMember(roster(),payload.designated_member),'forbidden');
        const old=get('jobs',v.digest);if(old){need(old.bytes===p.canonicalize(signed),'conflict');return old.publish_ack;}
        const tombstone=get('job_tombstones',v.digest);
        if(tombstone){need(tombstone.envelope_digest===p.digest(signed),'conflict');return {...tombstone.publish_ack,job:signed};}
        need(db.prepare("SELECT count(*) AS n FROM jobs WHERE json_extract(data,'$.author')=?").get(device).n<config.limits.deviceJobs,'quota_exceeded');
        const retainedJobs=db.prepare('SELECT count(*) AS n FROM jobs').get().n;
        // Removal cancels this author's work. Reclaim only under circle pressure.
        const reclaimable=retainedJobs>=config.limits.circleJobs?
          all('jobs').find(job=>TERMINAL.has(job.state)&&!p.findMember(roster(),job.author)):null;
        need(retainedJobs-(reclaimable?1:0)<config.limits.circleJobs,'quota_exceeded');
        need(payload.roster_epoch===roster().epoch,'roster_stale');
        if(payload.audience)need(payload.audience.device_keys.every(key=>p.findMember(roster(),key)));
        need(seconds(payload.created_at)<=t+60);need(seconds(payload.expires_at)>t,'job_expired');
        need(seconds(payload.expires_at)-seconds(payload.created_at)<=config.limits.maxJobLifetimeSeconds&&
          seconds(payload.expires_at)<=t+config.limits.maxJobLifetimeSeconds);
        admitJob(signed,v.digest,ctx);
        pin(payload.prompt,t,device);if(payload.source.kind==='archive')pin(payload.source.artifact,t,device);
        const job={job_digest:v.digest,signed,bytes:p.canonicalize(signed),author:device,state:'queued',attempts_started:0,
          max_attempts:payload.max_attempts??3,generation:0,current_attempt:null,result_digest:null,published_at:t,expiry:seconds(payload.expires_at)};
        job.publish_ack=view(job,t);saveJob(job);
        // Install the new references first so shared input blobs survive retirement.
        if(reclaimable)retire(reclaimable);
        return job.publish_ack;
      });
    },
    // Open jobs for lenders to choose from: queued only, oldest-queued first, with the server's publish time. Read-only admission
    // metadata. `poll()` re-reads under one authenticated request (one nonce however long the wait), like openClaimPoll.
    openOffersPoll(device,{limit=50,cursor=null,accepts=['results_v1']},ctx) {
      need(Number.isInteger(limit)&&limit>=1&&limit<=100,'cursor_invalid');
      let after=null;
      if(cursor!==null) {
        try {const c=JSON.parse(Buffer.from(String(cursor),'base64url').toString());
          need(c&&Number.isSafeInteger(c.p)&&typeof c.d==='string'&&/^sha256:[0-9a-f]{64}$/.test(c.d)&&Object.keys(c).length===2);after=c;}
        catch {fail('cursor_invalid');}
      }
      const session={};let closed=false;
      const poll=()=>{
        need(!closed,'invalid_request');
        return run('GET',ctx.route,null,ctx,(_,t)=>{
          const rows=db.prepare('SELECT id FROM job_queue WHERE ready<=? AND expiry>=? AND (published>? OR (published=? AND id>?)) ORDER BY published,id')
            .all(t,t+30,after?.p??-1,after?.p??-1,after?.d??'');
          const items=[];let next_cursor=null;
          for(const {id} of rows) {
            const original=loadJob(id),job=normalize(original,t);
            if(JSON.stringify(job)!==JSON.stringify(original))saveJob(job);
            // Frozen audience: skipped before pagination, so a later joiner never sees the job or a cursor that points at it.
            if(job.state!=='queued'||job.declined_by?.includes(device)||!visible(job,device)||!canListJob(job.signed.payload,accepts))continue;
            // A job is open only where it may be dispatched: others preserve it and never list it
            // (the no-eligible-peer waiting state).
            if(!dispatchHere(job.signed.payload,device))continue;
            if(items.length===limit){next_cursor=Buffer.from(JSON.stringify({p:items.at(-1).published,d:items.at(-1).job_digest})).toString('base64url');break;}
            items.push({...view(job,t),published_at:iso(job.published_at),published:job.published_at});
          }
          const page=()=>({items:items.map(({published,...item})=>item),next_cursor,revision:offersRevision()});
          while(controlBytes(page())>responseLimit(ctx)) {
            need(items.length>1,'payload_too_large');
            items.pop();next_cursor=Buffer.from(JSON.stringify({p:items.at(-1).published,d:items.at(-1).job_digest})).toString('base64url');
          }
          return page();
        },{device,session});
      };
      return {poll,close(){closed=true;}};
    },
    openJobWatch(device,id,ctx) {
      const session={};let closed=false;
      const poll=()=>{
        need(!closed,'invalid_request');
        return run('GET',ctx.route,null,ctx,(_,t)=>{
          const original=seeJob(id,device),job=normalize(original,t);
          if(JSON.stringify(job)!==JSON.stringify(original))saveJob(job);
          const attempt=job.current_attempt?get('attempts',job.current_attempt):null;
          const stopRequest=attempt?get('attempt_stop_requests',attempt.attempt_id):null;
          return {revision:jobWatchRevision(view(job,t,true),stopRequest)};
        },{device,session});
      };
      return {poll,close(){closed=true;}};
    },
    declineJob(device,digest,ctx) {
      return run('POST','/jobs/'+digest.slice(7)+'/decline',{},ctx,(_,t)=>{
        need(p.circleWorkAllowed(roster(),device,'lend'),'forbidden');
        const job=normalize(loadJob(digest),t);
        need(visible(job,device),'not_found');
        if(job.state==='queued'&&!job.declined_by?.includes(device)) {
          // Revoked devices cannot rejoin. Keep the per-job list bounded by current membership.
          job.declined_by_version=1;
          job.declined_by=[...(job.declined_by??[]).filter(key=>p.findMember(roster(),key)),device];
          saveJob(job);
          put('circle','offers_revision',{n:offersRevision()+1});
        }
        return {job_digest:digest,declined:job.state==='queued'||job.declined_by?.includes(device)===true};
      },{device});
    },
    claimJob(device,digest,advertisement,ctx,leaseSeconds=120) {
      return run('POST',jobRoute(digest)+'/claim',{advertisement,lease_seconds:leaseSeconds},ctx,(_,t)=>
        ((advertisementValid(advertisement)),claim(device,digest,advertisement,t,leaseDuration(leaseSeconds))),{device});
    },
    claimNext(device,advertisement,ctx,leaseSeconds=120,exclude) {
      return run('POST','/jobs/claim-next',{advertisement,lease_seconds:leaseSeconds,...(exclude===undefined?{}:{exclude})},ctx,(_,t)=>{
        touchPoll(device,t);
        leaseDuration(leaseSeconds);advertisementValid(advertisement);const excluded=exclusions(exclude);
        for(const job of eligibleJobs(advertisement,t)) {if(excluded.has(job.id))continue;const result=claim(device,job.id,advertisement,t,leaseSeconds,true);if(result)return result;}
        return null;
      },{device});
    },
    start(device,id,generation,ctx) {
      return run('POST','/attempts/'+id+'/start',{generation},ctx,(_,t)=>{
        const {a,job}=active(device,id,generation,t);
        // Unknown legacy markers are not evidence of execution or permission to run.
        need(Object.hasOwn(a,'execution_started_at'),'conflict');
        if(a.execution_started_at===null) {
          need(job.attempts_started<job.max_attempts,'retry_exhausted');
          a.execution_started_at=iso(t);
          put('attempts',id,a);saveJob(job);
        }
        return a;
      },{device});
    },
    observeExecutionStart(device,id,generation,ctx,observed_at) {
      return run('POST','/attempts/'+id+'/observed-start',{generation,...(observed_at===undefined?{}:{observed_at})},ctx,(_,t)=>{
        let a=get('attempts',id);need(a,'not_found');need(a.holder===device,'forbidden');
        need(a.generation===generation,'stale_attempt');
        need(typeof a.execution_started_at==='string','conflict');
        if(observed_at!==undefined)need(typeof observed_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(observed_at)&&
          Number.isFinite(seconds(observed_at))&&iso(seconds(observed_at))===observed_at&&seconds(observed_at)<=t+60);
        if(a.execution_observed_at==null) {
          const raw=get('jobs',a.job_digest),job=raw?normalize(raw,t):null;
          if(job?.projected_attempt){saveJob(job);a=get('attempts',id);}
          // A stopped attempt the job no longer assigns: its try was given up with its stop, and the job now belongs to a newer
          // attempt. Its late observation must not count against that newer try (I2c), so it changes nothing here. The reply
          // carries `observation: 'superseded'` and no execution_observed_at; nothing here proves the agent ran.
          if(job&&a.compute_stopped===true&&job.current_attempt!==id)return {...a,observation:'superseded'};
          // A stop report or the fence's time bound already freed the job. The observation still shows this try began,
          // so it spends a try (a requeued job whose tries are now spent fails), but it gives the try no authority back.
          const gone=a.compute_stopped===true||(job!=null&&fenceEnded(a,job,t));
          const counted=typeof observedExecutionTime(a)==='string',wasFenced=fenced(a)&&!gone;
          a.execution_observed_at=observed_at??iso(t);
          if(job&&!counted)job.attempts_started++;
          if(job&&wasFenced)resolveFence(a,job,'observed',t);
          if(job&&gone&&!counted&&job.state==='queued'&&job.attempts_started>=job.max_attempts)
            {job.state='failed';job.terminal_reason=a.reason;job.terminal_at=t;}
          if(job&&(!counted||wasFenced))saveJob(job);
          put('attempts',id,a);
        }
        return a;
      },{device});
    },
    requestStop(device,id,generation,ctx) {
      return run('POST','/attempts/'+id+'/stop-request',{generation},ctx,(_,t)=>{
        const {a}=active(device,id,generation,t,'lease_expired');
        need(typeof a.execution_started_at==='string','conflict');
        const prior=get('attempt_stop_requests',id);
        if(prior) {
          need(prior.attempt_id===id&&prior.job_digest===a.job_digest&&prior.generation===generation,'stale_attempt');
          return prior;
        }
        const request={attempt_id:id,job_digest:a.job_digest,generation,requested_at:iso(t)};
        put('attempt_stop_requests',id,request);
        return request;
      },{device});
    },
    renew(device,id,generation,ctx,leaseSeconds=120) {
      return run('POST','/attempts/'+id+'/renew',{generation,lease_seconds:leaseSeconds},ctx,(_,t)=>{
        leaseDuration(leaseSeconds);const {a,job}=active(device,id,generation,t);
        a.lease_expires_at=iso(Math.min(Math.max(seconds(a.lease_expires_at),t+leaseSeconds),job.expiry,seconds(roster().valid_until)));
        put('attempts',id,a);saveJob(job);return a;
      },{device});
    },
    release(device,id,generation,reason,ctx) {
      return run('POST','/attempts/'+id+'/release',{generation,reason},ctx,(_,t)=>finishAttempt(device,id,generation,reason,t,'released'),{device});
    },
    fail(device,id,generation,reason,ctx) {
      return run('POST','/attempts/'+id+'/fail',{generation,reason},ctx,(_,t)=>finishAttempt(device,id,generation,reason,t,'failed'),{device});
    },
    complete(signed,ctx) {
      signed=envelope(signed);const payload=signed.payload;
      return run('POST','/attempts/'+payload.attempt_id+'/complete',signed,ctx,(device,t)=>{
        const v=verify('result',signed,device),tombstone=get('job_tombstones',payload.job_digest);
        if(tombstone) {
          need(tombstone.result,'job_terminal');
          need(tombstone.result.executor===device,'forbidden');
          need(tombstone.result.envelope_digest===p.digest(signed),'conflict');return tombstone.result.ack;
        }
        const a=get('attempts',payload.attempt_id);need(a,'not_found');
        checked(p.checkExecutor(payload,device,a));checked(p.checkAttempt(payload,a));checked(p.checkJobDigest(payload,a.job_digest));
        // The receipt reports the designation this execution honored, checked against the job that
        // named it: a designated job's completion says so, and an undesignated one never claims it.
        const jobForReceipt=loadJob(a.job_digest);
        need((jobForReceipt.signed.payload.designated_member!==undefined)===
          payload.receipt.capabilities_applied.includes(DESIGNATED_MEMBER_CAPABILITY),'requirements_mismatch');
        const original=get('results',a.job_digest);
        if(original) {need(original.attempt_id===a.attempt_id,'stale_attempt');need(original.bytes===p.canonicalize(signed),'conflict');return original.ack;}
        // A lease fences execution, not delivery of work already completed by that
        // same generation. Cancellation, revocation and successors still fence delivery.
        const job=normalize(loadJob(a.job_digest),t);
        const delayed=leaseLapsed(job,a)&&job.generation===payload.generation&&
          p.findMember(roster(),job.author)&&p.findMember(roster(),device);
        if(!delayed)active(device,a.attempt_id,payload.generation,t);
        delete job.projected_attempt;
        need(typeof a.execution_started_at==='string','conflict');
        const historical=get('rosters',payload.roster_epoch);
        need(payload.roster_epoch<=roster().epoch&&historical&&p.findMember(historical.signed.payload,device),'roster_stale');
        need(seconds(payload.submitted_at)<=t+60);
        const req=job.signed.payload.requirements,receipt=payload.receipt;
        need(p.checkJobSelection(job.signed.payload,receipt.selection,a.selection).ok,'requirements_unsupported');
        need(p.canonicalize(receipt.source)===p.canonicalize(job.signed.payload.source),'conflict');
        need(!req.harness||req.harness.includes(receipt.harness),'requirements_unsupported');
        need(!req.model||req.model.any_of.includes(receipt.model),'requirements_unsupported');
        need(req.egress===receipt.egress_applied&&req.capabilities.every(c=>receipt.capabilities_applied.includes(c)),'requirements_unsupported');
        // The signed output must answer the signed request (absent on both sides = branch), or it never becomes the accepted result.
        need(p.resultKind({output:payload.output})===p.resultKind(job.signed.payload),'requirements_unsupported');
        const limitNames={cpu:'cpu',memory_bytes:'memory',wall_seconds:'wall',output_bytes:'output',disk_bytes:'storage'};
        for(const [k,n] of Object.entries(req.limits)) {
          need(receipt.limits_applied[k]<=n,'requirements_unsupported');
          const name=limitNames[k],unenforced=receipt.unenforced?.includes(name)===true;
          const enforced=receipt.enforced_limits?.includes(name);
          need(!(unenforced&&enforced),'requirements_unsupported');
          if(req.limit_modes?.[k]!=='preferred')need(!unenforced&&enforced!==false,'requirements_unsupported');
          else if(enforced===false)need(unenforced,'requirements_unsupported');
        }
        need(payload.candidate.bytes+payload.transcript.bytes<=req.limits.output_bytes,'quota_exceeded');
        need(payload.candidate.bytes+payload.transcript.bytes<=receipt.limits_applied.output_bytes &&
          receipt.duration_ms<=receipt.limits_applied.wall_seconds*1000,'requirements_unsupported');
        need(controlBytes(signed)<=responseLimit(ctx),'payload_too_large');
        pin(payload.candidate,t,device);pin(payload.transcript,t,device);
        const ack={job_digest:job.job_digest,result_digest:v.digest,attempt_id:a.attempt_id,generation:a.generation,accepted_at:iso(t),status:'result-accepted'};
        put('results',job.job_digest,{signed,bytes:p.canonicalize(signed),digest:v.digest,attempt_id:a.attempt_id,ack});
        a.state='completed';put('attempts',a.attempt_id,a);job.state='result-accepted';job.result_digest=v.digest;job.terminal_at=t;saveJob(job);return ack;
      });
    },
    cancel(signed,ctx) {
      signed=envelope(signed);const payload=signed.payload;
      return run('POST',jobRoute(payload.job_digest)+'/cancel',signed,ctx,(device,t)=>{
        const v=verify('cancellation',signed,device);checked(p.checkAuthor(payload,device));
        const tombstone=get('job_tombstones',payload.job_digest);
        need(!tombstone?.audience||tombstone.audience.includes(device),'not_found');
        if(tombstone){need(tombstone.cancellation,'job_terminal');need(tombstone.cancellation.envelope_digest===p.digest(signed),'conflict');return tombstone.cancellation.ack;}
        const job=normalize(seeJob(payload.job_digest,device),t);
        // The front door of the two-state Stop: only the submitting borrower or the circle's steward may
        // cancel. Authority revocation is immediate; compute stopping is observed separately below.
        const steward=roster().authority_chain?.at(-1)?.payload?.steward?.key_id??null;
        need(job.author===device||steward===device,'forbidden');
        const old=get('cancellations',job.job_digest);if(old){need(old.bytes===p.canonicalize(signed),'conflict');return old.ack;}
        need(payload.roster_epoch===roster().epoch,'roster_stale');need(seconds(payload.created_at)<=t+60);
        need(!TERMINAL.has(job.state),'job_terminal');
        saveJob(job);
        let a=job.current_attempt?get('attempts',job.current_attempt):null;
        if(a?.state==='active'){a.state='cancelled';a.reason=payload.reason;put('attempts',a.attempt_id,a);}
        job.state='cancelled';job.terminal_at=t;job.terminal_reason=payload.reason;delete job.projected_attempt;saveJob(job);
        const ack={job_digest:job.job_digest,cancellation_digest:v.digest,requested_at:iso(t),authority_revoked:true,compute_stopped:a?a.compute_stopped:true,attempt:a};
        put('cancellations',job.job_digest,{signed,bytes:p.canonicalize(signed),ack});return ack;
      });
    },
    stopped(device,id,generation,stopped_at,ctx) {
      return run('POST','/attempts/'+id+'/stopped',{generation,stopped_at},ctx,(_,t)=>{
        let a=get('attempts',id);need(a,'not_found');need(a.holder===device,'forbidden');need(a.generation===generation,'stale_attempt');
        const job=normalize(loadJob(a.job_digest),t);saveJob(job);a=get('attempts',id);
        need(a.state!=='active','conflict');
        need(typeof stopped_at==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(stopped_at)&&Number.isFinite(seconds(stopped_at))&&iso(seconds(stopped_at))===stopped_at&&seconds(stopped_at)<=t+60);
        const wasFenced=fenced(a);
        if(!a.compute_stopped){a.compute_stopped=true;a.stopped_at=stopped_at;put('attempts',id,a);}
        if(wasFenced&&resolveFence(a,job,'stopped',t))saveJob(job);
        return a;
      },{device});
    },
    getJob(device,id,ctx,declineCount=false) {return run('GET',jobRoute(id),null,ctx,(_,t)=>view(seeJob(id,device),t,declineCount),{device});},
    // P17a: when the host will delete the job, and whether this device may delete it now.
    getRetention(device,id,ctx) {
      return run('GET',jobRoute(id)+'/retention',null,ctx,(_,t)=>{
        const job=normalize(seeJob(id,device),t),terminal=TERMINAL.has(job.state);
        const endedAt=terminal?(job.terminal_at??(job.state==='expired'?job.expiry:t)):null;
        return {job_digest:id,state:job.state,ended_at:endedAt===null?null:iso(endedAt),
          retained_until:endedAt===null?null:iso(endedAt+config.limits.terminalRetentionSeconds),
          deletable:terminal&&(job.author===device||get('circle','config').owner_device===device)};
      },{device});
    },
    // P17a: delete a finished job now. Its author or the circle's owner device may; a running job must be cancelled first.
    deleteJob(device,id,ctx) {
      return run('POST',jobRoute(id)+'/delete',{},ctx,(_,t)=>{
        const raw=get('jobs',id),tomb=get('job_tombstones',id);
        need(raw?visible(raw,device):!tomb?.audience||tomb.audience.includes(device),'not_found');
        if(!raw&&tomb) {need(tomb.author===device||get('circle','config').owner_device===device,'forbidden');return {job_digest:id,deleted:true,at:iso(tomb.deleted_at??tomb.terminal_at??t)};}
        need(raw,'not_found');
        const job=normalize(raw,t);
        need(job.author===device||get('circle','config').owner_device===device,'forbidden');
        need(TERMINAL.has(job.state),'conflict');
        retire({...job,terminal_at:job.terminal_at??t},{by:device,at:t});
        return {job_digest:id,deleted:true,at:iso(t)};
      },{device});
    },
    /** The HTTP owner tells the store how to remove a blob file, and which files on disk no row owns. */
    setBlobRemover(remove) {blobRemover=remove;flushBlobGarbage();},
    orphanBlob(name) {
      const digest='sha256:'+name;
      return !get('artifacts',digest)&&!all('reservations').some(r=>r.ref?.digest===digest);
    },
    getAttempt(device,id,ctx) {
      return run('GET','/attempts/'+id,null,ctx,(_,t)=>{
        const a=get('attempts',id);need(a,'not_found');const job=normalize(seeJob(a.job_digest,device),t);
        return job.projected_attempt?.attempt_id===id?job.projected_attempt:a;
      },{device});
    },
    accountLease(device,id,body,ctx) {
      return run('POST','/attempts/'+id+'/account-lease',body,ctx,(_,t)=>{
        const {a,job}=active(device,id,body.generation,t);
        need(!a.compute_stopped&&!get('attempt_stop_requests',id),'lease_fenced');
        const selection=a.selection;
        need(selection&&p.canonicalize(selection)===p.canonicalize(body.selection),'lease_fenced');
        historicalAuthor(job);
        need(p.findMember(roster(),job.author)&&p.findMember(roster(),device),'forbidden');
        let pem=get('circle','account_lease_key')?.pem;
        if(!pem){pem=generateKeyPairSync('ed25519').privateKey.export({format:'pem',type:'pkcs8'});
          put('circle','account_lease_key',{pem});}
        const privateKey=createPrivateKey(pem);
        const binding={circle:config.circle,holder:device,jobId:a.job_digest,attemptId:id,selection,
          fence:a.generation,membershipEpoch:roster().epoch,expiresAtMs:seconds(a.lease_expires_at)*1000};
        return {proof:signLease({...binding,challenge:body.challenge},privateKey),binding,
          publicKey:createPublicKey(privateKey).export({format:'pem',type:'spki'})};
      },{device});
    },
    getStopRequest(device,id,ctx) {
      return run('GET','/attempts/'+id+'/stop-request',null,ctx,()=>{
        const a=get('attempts',id);need(a,'not_found');
        seeJob(a.job_digest,device);
        const request=get('attempt_stop_requests',id);
        if(request)need(request.attempt_id===id&&request.job_digest===a.job_digest&&request.generation===a.generation,'internal_error');
        return request;
      },{device});
    },
    getResult(device,id,ctx) {return run('GET',jobRoute(id)+'/result',null,ctx,()=>{seeJob(id,device);const r=get('results',id);need(r,'conflict');return r.signed;},{device});},
    heartbeat(device,body,ctx) {
      return run('POST','/heartbeat',body,ctx,(_,t)=>{
        checkHeartbeat(body);
        const row=get('presence',device)??{};
        if(body.profile!==undefined){
          const profile={body,proof:ctx.proof};
          const options={circle:config.circle,origin:config.origin,member:p.findMember(roster(),device)};
          const valid=verifyMemberProfile(profile,options),previous=verifyMemberProfile(row.member_profile,options);
          need(valid,'invalid_request');
          if(!previous||valid.revision>previous.revision)row.member_profile=profile;
        }
        if(Object.keys(body).every(k=>['capabilities','profile'].includes(k))){
          row.member_capabilities=[...body.capabilities];row.capabilities_at=t;put('presence',device,row);
          return {received_at:iso(t),online_seconds:ONLINE_SECONDS};
        }
        // A late, older heartbeat never replaces a newer one. seq counts within one `boot` (a lender process): a restart
        // starts at 0, so a heartbeat from a different boot, or from one that sends none, always replaces the stored one.
        if(!row.heartbeat||body.boot!==row.heartbeat.boot||body.seq>=row.heartbeat.seq){row.heartbeat={...body};row.heartbeat_at=t;row.member_capabilities=[...body.capabilities];row.capabilities_at=t;put('presence',device,row);}
        return {received_at:iso(t),online_seconds:ONLINE_SECONDS};
      },{device});
    },
    getPresence(device,ctx) {return run('GET','/presence',null,ctx,(_,t)=>presenceView(t),{device});},
    // Only the author and the current attempt holder can see live output. Circle ownership grants no access.
    getLiveTranscript(device,id,ctx) {
      return run('GET',jobRoute(id)+'/transcript',null,ctx,(_,t)=>{
        const job=seeJob(id,device),a=job.current_attempt?get('attempts',job.current_attempt):null;
        need(job.author===device||a?.holder===device,'not_found');
        const row=a?db.prepare('SELECT data FROM live_transcripts WHERE attempt=? AND job=?').get(a.attempt_id,id):null;
        if(row)return {...JSON.parse(row.data),available:true};
        const presence=a?get('presence',a.holder):null;
        const supported=!!(presence&&t-presence.heartbeat_at<ONLINE_SECONDS&&presence.heartbeat?.capabilities.includes('transcript_relay_v1'));
        return {job_digest:id,attempt:a?.attempt_id??null,seq:0,at:null,text:'',truncated:false,available:supported};
      },{device});
    },
    postLiveTranscript(device,id,body,ctx) {
      return run('POST',jobRoute(id)+'/transcript',body,ctx,(_,t)=>{
        need(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===4&&
          ['attempt','seq','text','truncated'].every(k=>Object.hasOwn(body,k)));
        need(typeof body.attempt==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(body.attempt));
        need(Number.isSafeInteger(body.seq)&&body.seq>0&&typeof body.text==='string'&&typeof body.truncated==='boolean');
        need(Buffer.byteLength(body.text)<=TRANSCRIPT_RELAY_LIMITS.snapshotBytes&&controlBytes(body)<=TRANSCRIPT_RELAY_LIMITS.requestBytes,'payload_too_large');
        const job=seeJob(id,device),a=get('attempts',body.attempt);
        need(a&&a.job_digest===id,'not_found');
        const current=job.current_attempt?get('attempts',job.current_attempt):null;
        need(job.author===device||a.holder===device||current?.holder===device,'not_found');
        need(a.holder===device,'forbidden');
        need(job.current_attempt===a.attempt_id,'stale_attempt');
        active(device,a.attempt_id,a.generation,t);
        need(typeof a.execution_started_at==='string','stale_attempt');
        const usage=db.prepare('SELECT * FROM live_transcript_usage WHERE attempt=?').get(a.attempt_id);
        need(!usage||body.seq>usage.seq,'stale_attempt');
        need(!usage||usage.updates<TRANSCRIPT_RELAY_LIMITS.maxUpdates,'quota_exceeded');
        need(!usage||t-usage.uploaded>=TRANSCRIPT_RELAY_LIMITS.minIntervalSeconds,'rate_limited');
        const ack={job_digest:id,attempt:a.attempt_id,seq:body.seq,at:iso(t)},snapshot={...ack,text:body.text,truncated:body.truncated};
        // Escaped JSON is bounded too; a 64 KiB raw snapshot can exceed the control response ceiling.
        need(controlBytes({...snapshot,available:true})<=responseLimit(ctx),'payload_too_large');
        const data=p.canonicalize(snapshot),bytes=Buffer.byteLength(data);
        const oldBytes=db.prepare('SELECT bytes FROM live_transcripts WHERE attempt=?').get(a.attempt_id)?.bytes??0;
        const total=db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM live_transcripts').get().bytes;
        const mine=db.prepare('SELECT COALESCE(SUM(bytes),0) AS bytes FROM live_transcripts WHERE device=?').get(device).bytes;
        need(total-oldBytes+bytes<=config.limits.transcriptCircleBytes&&mine-oldBytes+bytes<=config.limits.transcriptDeviceBytes,'quota_exceeded');
        db.prepare('INSERT INTO live_transcripts(attempt,job,device,uploaded,bytes,data) VALUES(?,?,?,?,?,?) ON CONFLICT(attempt) DO UPDATE SET uploaded=excluded.uploaded,bytes=excluded.bytes,data=excluded.data')
          .run(a.attempt_id,id,device,t,bytes,data);
        db.prepare('INSERT INTO live_transcript_usage(attempt,job,seq,updates,uploaded) VALUES(?,?,?,?,?) ON CONFLICT(attempt) DO UPDATE SET seq=excluded.seq,updates=excluded.updates,uploaded=excluded.uploaded')
          .run(a.attempt_id,id,body.seq,(usage?.updates??0)+1,t);
        return ack;
      },{device});
    },
    // Optional progress channel: coarse steps from the lender, visible to the job's author and its lenders only.
    postProgress(device,id,body,ctx) {
      return run('POST',jobRoute(id)+'/progress',body,ctx,(_,t)=>{
        need(body&&typeof body==='object'&&!Array.isArray(body)&&Object.keys(body).length===3);
        const stage=Object.hasOwn(body,'stage');
        need((stage?['attempt','stage','elapsed_s']:['attempt','step','kind']).every(k=>Object.hasOwn(body,k)));
        need(typeof body.attempt==='string');
        if(stage) {
          need(['preparing','agent','checks','screenshots','sending'].includes(body.stage));
          need(Number.isSafeInteger(body.elapsed_s)&&body.elapsed_s>=0&&!Object.is(body.elapsed_s,-0));
        } else {
          need(['step','done','fail'].includes(body.kind));
          need(typeof body.step==='string'&&[...body.step].length>=1&&[...body.step].length<=PROGRESS_STEP_MAX&&!/[\u0000-\u001f\u007f]/.test(body.step));
        }
        loadJob(id);
        const a=get('attempts',body.attempt);need(a&&a.job_digest===id,'not_found');need(a.holder===device,'forbidden');
        const ongoing=stage||body.kind==='step';
        if(ongoing)need(a.state==='active','stale_attempt');
        if(ongoing)need(seconds(a.lease_expires_at)>t,'stale_attempt');
        const mine=db.prepare("SELECT data FROM progress WHERE job=? AND json_extract(data,'$.attempt')=? ORDER BY seq DESC").all(id,body.attempt).map(r=>JSON.parse(r.data));
        need(mine.length<PROGRESS_PER_ATTEMPT,'quota_exceeded');
        need(!ongoing||!mine.length||t-seconds(mine[0].at)>=PROGRESS_MIN_SECONDS,'rate_limited');
        const seq=db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS n FROM progress WHERE job=?').get(id).n;
        const entry={job:id,attempt:body.attempt,seq,at:iso(t),...(stage?
          {stage:body.stage,elapsed_s:body.elapsed_s}:{step:body.step,kind:body.kind})};
        db.prepare('INSERT INTO progress(job,seq,data) VALUES(?,?,?)').run(id,seq,JSON.stringify(entry));
        return entry;
      },{device});
    },
    getProgress(device,id,{after=0}={},ctx) {
      return run('GET',jobRoute(id)+'/progress'+(after?'?after='+after:''),null,ctx,()=>{
        need(Number.isSafeInteger(after)&&after>=0,'cursor_invalid');
        const job=get('jobs',id);
        // Anyone else, and an unknown job, get the same answer: nothing is disclosed.
        need(job&&visible(job,device),'not_found');
        const lender=db.prepare("SELECT 1 FROM attempts WHERE json_extract(data,'$.job_digest')=? AND json_extract(data,'$.holder')=?").get(id,device);
        need(job.author===device||lender,'not_found');
        const entries=db.prepare('SELECT data FROM progress WHERE job=? AND seq>? ORDER BY seq LIMIT ?').all(id,after,PROGRESS_PER_ATTEMPT*4).map(r=>JSON.parse(r.data));
        return {job_digest:id,entries,next_after:entries.at(-1)?.seq??after};
      },{device});
    },
    listJobs(device,{limit=50,cursor=null,accepts=[]}={},ctx) {
      // A client names the parent, result and source fields its closed validator can read. Filtering
      // precedes paging, so its pages stay full and its cursor ends exactly when its own jobs end.
      const typed=accepts.includes('results_v1'),parents=accepts.includes('parent_link_v1'),budgets=accepts.includes('budget_v1');
      const sourceCapabilities=optionalListCapabilities(accepts);
      const route='/jobs?limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):'');
      return run('GET',route,null,ctx,(_,t)=>{
        need(Number.isInteger(limit)&&limit>=1&&limit<=100,'cursor_invalid');
        let state;
        if(cursor) {state=get('cursors',cursor);need(state&&state.device===device&&state.limit===limit&&state.circle===config.circle&&(state.typed===true)===typed&&(state.parents===true)===parents&&(state.budgets===true)===budgets&&JSON.stringify(state.sourceCapabilities??[])===JSON.stringify(sourceCapabilities)&&state.expires>t,'cursor_invalid');}
        else state={device,limit,circle:config.circle,typed,parents,budgets,sourceCapabilities,expires:t+900,watermark:db.prepare('SELECT COALESCE(MAX(seq),0) AS n FROM jobs').get().n,position:null};
        const rows=db.prepare('SELECT seq,data FROM jobs WHERE seq<=?').all(state.watermark).map(r=>JSON.parse(r.data))
          .filter(j=>visible(j,device)&&canListJob(j.signed.payload,accepts))
          .sort((a,b)=>a.published_at-b.published_at||a.job_digest.localeCompare(b.job_digest))
          .filter(j=>!state.position||j.published_at>state.position.time||(j.published_at===state.position.time&&j.job_digest>state.position.digest));
        const selected=[],items=[],cursorId=randomUUID();let next_cursor=null;
        for(const job of rows.slice(0,limit)) {
          const item=view(job,t,accepts.includes('decline_count_v1')),next=rows.length>items.length+1?cursorId:null;
          if(controlBytes({items:[...items,item],next_cursor:next})>Math.min(ctx?.maxResponseBytes??MAX_CONTROL_BYTES,MAX_CONTROL_BYTES)) {
            need(items.length>0,'payload_too_large');break;
          }
          selected.push(job);items.push(item);
        }
        if(rows.length>selected.length) {const last=selected.at(-1);next_cursor=cursorId;put('cursors',next_cursor,{...state,position:{time:last.published_at,digest:last.job_digest}});}
        return {items,next_cursor};
      },{device});
    },
    reserveArtifact(device,ref,ctx) {
      refValid(ref);
      const ownerToken=ctx?.transport?randomUUID():undefined;
      try {return run('PUT',artifactRoute(ref.digest),null,ctx,(_,t)=>{
        if(ctx.job)need(openForDelivery(device,ctx.job,t),'job_terminal');
        const old=get('artifacts',ref.digest);if(old)need(old.ref.bytes===ref.bytes&&old.ref.media_type===ref.media_type,'conflict');
        if(ctx.transport) {
          const pending=all('reservations').find(r=>r.device===device&&r.transport&&r.install_pending&&
            !r.owner_live&&!r.temp_name&&p.canonicalize(r.ref)===p.canonicalize(ref));
          if(pending) {
            // Only an ended, cleaned-up request is adoptable. Each adoption
            // gets a new capability so delayed calls from prior owners are inert.
            pending.owner_token=ownerToken;pending.owner_live=true;delete pending.retrying;
            pending.roster_epoch=roster().epoch;pending.created=t;
            put('reservations',pending.reservation_id,pending);
            return {reservation_id:pending.reservation_id,owner_token:pending.owner_token,adopted_uncertain_retry:true,...ref};
          }
        }
        const d=counter('device:'+device),c=counter('circle'),limits=config.limits;
        const counts=id=>db.prepare('SELECT retained,reserved FROM artifact_counts WHERE device=?').get(id)??{retained:0,reserved:0};
        const dc=counts(device),cc=counts('');
        need(ref.bytes<=limits.maxArtifactBytes&&d.retained_bytes+d.reserved_bytes+ref.bytes<=limits.deviceBytes&&
          c.retained_bytes+c.reserved_bytes+ref.bytes<=limits.circleBytes&&d.uploads<limits.concurrentUploads&&
          dc.retained+dc.reserved<limits.deviceArtifacts&&cc.retained+cc.reserved<limits.circleArtifacts,'quota_exceeded');
        const reservation={reservation_id:freshId('reservations'),device,ref,roster_epoch:roster().epoch,created:t,...(ctx.transport?{transport:true,owner_token:ownerToken,owner_live:true}:{})};need(!get('reservations',reservation.reservation_id),'conflict');
        adjust(device,0,ref.bytes,1);put('reservations',reservation.reservation_id,reservation);return {reservation_id:reservation.reservation_id,...(ctx.transport?{owner_token:reservation.owner_token}:{}),...ref};
      },{device,artifact:ref});}catch(error){
        // No caller received this request's reservation, so no stream opened.
        // The COMMIT may nevertheless have applied, including a retry adoption.
        if(ownerToken)abandonedUploads.set(ownerToken,{device,temporaryRemoved:true});
        throw error;
      }
    },
    commitArtifact(device,id,actual,ctx) {
      return run('POST','/artifact-reservations/'+id+'/commit',actual,ctx,(_,t)=>{
        const r=get('reservations',id);need(r,'not_found');need(r.device===device,'forbidden');
        need(!r.transport,'conflict');
        let error=null;
        try {refValid(actual);} catch {error='invalid_request';}
        error ??= actual.digest!==r.ref.digest?'digest_mismatch':actual.bytes!==r.ref.bytes?'size_mismatch':actual.media_type!==r.ref.media_type?'conflict':null;
        if(error){releaseReservation(r);return {__error:error};}
        const old=get('artifacts',actual.digest);
        if(old && p.canonicalize(old.ref)!==p.canonicalize(actual)){releaseReservation(r);return {__error:'conflict'};}
        releaseReservation(r,true);
        if(!old){adjust(device,actual.bytes,0,0);put('artifacts',actual.digest,{ref:actual,uploader:device,created:t,pinned:false});}
        db.prepare('INSERT OR IGNORE INTO artifact_holders(digest,device) VALUES(?,?)').run(actual.digest,device);
        reconcileUploads(actual.digest);
        return actual;
      },{device});
    },
    releaseArtifactReservation(device,id,ctx) {
      return run('POST','/artifact-reservations/'+id+'/release',{},ctx,()=>{
        const r=get('reservations',id);if(r){need(r.device===device,'forbidden');releaseReservation(r);}return {released:true};
      },{device});
    },
    listArtifactReservations(device,ctx) {
      return run('GET','/artifact-reservations',null,ctx,()=>all('reservations').filter(r=>r.device===device)
        .map(r=>({reservation_id:r.reservation_id,...r.ref,created_at:iso(r.created)})),{device});
    },
    recoverArtifactReservations(device,ids,ctx) {
      return run('POST','/artifact-reservations/recover',{reservation_ids:ids},ctx,()=>{
        need(Array.isArray(ids)&&ids.length<=100&&ids.every(id=>typeof id==='string'));
        const rows=[...new Set(ids)].map(id=>get('reservations',id)).filter(Boolean);
        for(const r of rows)need(r.device===device,'forbidden');
        for(const r of rows)releaseReservation(r);
        return {released:rows.length};
      },{device});
    },
    // The authenticated HTTP transport uses this to decide whether an existing-blob retry must verify the sender's stream.
    requiresArtifactProof(device,digest) {return !get('artifacts',digest)||!artifactVisible(digest,device);},
    // Continuation of an already authenticated read: no nonce or epoch replay.
    recheckArtifactRead(device,id) {
      authMember(device,roster(),now());
      need(get('artifacts',id)&&artifactVisible(id,device),'not_found');
    },
    getArtifact(device,id,ctx,method='GET') {need(['GET','HEAD'].includes(method));return run(method,artifactRoute(id),null,ctx,(_,t)=>{
      const a=get('artifacts',id);need(a&&artifactVisible(id,device),'not_found');
      // A lender probing for a result file it is about to name keeps that file until the job has delivered.
      if(ctx?.job)holdForDelivery(device,ctx.job,id,t);
      return a.ref;
    },{device});},
    getQuotas(device,ctx) {return run('GET','/quotas',null,ctx,()=>({device:counter('device:'+device),circle:counter('circle'),limits:Object.fromEntries(['deviceBytes','circleBytes','maxArtifactBytes','concurrentUploads'].map(key=>[key,config.limits[key]]))}),{device});},
    // Body is a bare signed Invite (long links only) or a publication {code, envelope, invite_binding}
    // that also makes the invite resolvable by its short code. Both are idempotent by invite_id.
    publishedInviteCodes() {return db.prepare('SELECT id FROM invite_codes').all().map(row=>row.id);},
    setInviteCodeRegistry(registry) {inviteCodeRegistry=registry;},
    registerInvite(input,ctx) {
      const body=envelope(input),publication=Object.hasOwn(body,'envelope')?body:null;
      if(publication) {
        need(Object.keys(publication).sort().join()==='code,envelope,invite_binding');
        need(p.INVITE_CODE_PATTERN.test(publication.code)&&p.canonicalize(publication).length<=MAX_PUBLICATION_BYTES);
      }
      const signed=publication?publication.envelope:body;
      let result;
      try {result=run('POST','/invites',body,ctx,(_,t)=>{
        if(publication)inviteCodeRegistry?.check(publication.code,config.circle);
        const old=get('invites',signed?.payload?.invite_id);
        if(old) {
          need(old.bytes===p.canonicalize(signed),'enrollment_conflict');
          if(publication&&old.code) {
            need(old.code===publication.code&&p.canonicalize(old.binding)===p.canonicalize(publication.invite_binding),'enrollment_conflict');
            return {code:old.code,envelope:old.signed,invite_binding:old.binding};
          }
          if(!publication)return old.signed;
        }
        need(roster().governance?.state!=='closed','forbidden');
        if(roster().authority_chain)need(p.canonicalize(signed.payload.authority_chain??null)===p.canonicalize(roster().authority_chain),'forbidden');
        const v=checked(p.verifyInvite(signed,{lanMode:config.lanMode===true,rootFingerprint:config.rootFingerprint,circle:config.circle,coordinator:config.origin,now:()=>t}));
        need((v.payload.lan_mode === true) === (config.lanMode === true), 'conflict');
        if(publication)need(p.verifyInviteBinding(signed,publication.invite_binding,{invitePublicKey:v.payload.invite_public_key}).ok);
        const id=v.payload.invite_id,reply=old?.signed??signed;
        if(publication) {
          const owner=get('invite_codes',publication.code);
          need(!owner||owner.invite_id===id,'conflict');
          put('invite_codes',publication.code,{invite_id:id});
          put('invites',id,{...(old??{signed,bytes:p.canonicalize(signed),consumed_by:null}),code:publication.code,binding:publication.invite_binding});
          // Reserve before COMMIT; an uncertain outcome must not permit shadowing.
          inviteCodeRegistry?.publish(publication.code,config.circle);
          return {code:publication.code,envelope:reply,invite_binding:publication.invite_binding};
        }
        if(!old)put('invites',id,{signed,bytes:p.canonicalize(signed),consumed_by:null});
        return reply;
      });} finally {
        // A COMMIT can succeed before its acknowledgement fails. Reconcile from
        // durable ownership even on error, before another circle can publish.
        if(publication)reconcileInviteCode(publication.code);
      }
      return result;
    },
    revokeInvite(body,ctx) {
      need(body&&Object.keys(body).sort().join()==='authorization,invite_id','invalid_request');
      return run('POST','/invites/revoke',body,ctx,(_,t)=>{
        checked(verifyInvitationRevocation(body,{circle:config.circle,origin:config.origin,roster:roster(),now:t,lanMode:config.lanMode===true}));
        const invite=get('invites',body.invite_id)??{};
        invite.revoked_at??=iso(t);put('invites',body.invite_id,invite);
        for(const e of all('enrollments')) if(e.invite_id===body.invite_id&&e.state==='pending') {
          e.state='rejected';e.ended=t;put('enrollments',e.enrollment_id,e);
        }
        return {invite_id:body.invite_id,revoked:true,revoked_at:invite.revoked_at};
      });
    },
    // The circle authority declines one join request. The joining computer reads the same answer, and a roster
    // signed before the decline can no longer admit that request (installRoster needs a live pending one).
    rejectEnrollment(body,ctx) {
      need(body&&Object.keys(body).sort().join()==='authorization,enrollment_id','invalid_request');
      return run('POST','/enrollments/reject',body,ctx,(_,t)=>{
        checked(verifyEnrollmentRejection(body,{circle:config.circle,origin:config.origin,roster:roster(),now:t,lanMode:config.lanMode===true}));
        const e=get('enrollments',body.enrollment_id);need(e,'not_found');
        if(e.state==='pending') {e.state=e.expires>t?'rejected':'expired';e.ended=e.state==='rejected'?t:e.expires;put('enrollments',e.enrollment_id,e);}
        return enrollmentView(e);
      });
    },
    /** Public, unauthenticated read of a published invite by short code. Returns only public material. */
    resolveInvite(code) {
      need(typeof code==='string'&&p.INVITE_CODE_PATTERN.test(code),'invalid_request');
      const entry=get('invite_codes',code),invite=entry&&get('invites',entry.invite_id);
      need(invite?.binding,'not_found');
      need(!invite.revoked_at,'enrollment_rejected');
      need(seconds(invite.signed.payload.expires_at)>now(),'enrollment_expired');
      return {envelope:invite.signed,invite_binding:invite.binding};
    },
    createEnrollment(body,ctx) {
      verifyEnrollmentInvite(body);
      return run('POST','/enrollments',body,ctx,(device,t)=>{
        const supplied=envelope(body.invite),id=supplied.payload.invite_id,invite=get('invites',id);need(invite,'not_found');
        need(invite.bytes===p.canonicalize(supplied),'enrollment_conflict');
        // Both the device request and invite-key proof are valid before charging admission.
        ctx?.admitEnrollment?.();
        const row=db.prepare('SELECT count FROM bootstrap_rates WHERE id=?').get(id);
        need(!row||row.count<10,'rate_limited');
        db.prepare('INSERT INTO bootstrap_rates(id,expires,count) VALUES(?,?,1) ON CONFLICT(id) DO UPDATE SET count=count+1').run(id,t+60);
        // A removed key stays removed (PUT /roster refuses a roster that lists it): a fresh invite cannot bring it back.
        need(!get('revoked_devices',device),'forbidden');
        const enrollments=all('enrollments').filter(e=>e.invite_id===id);
        if(supplied.payload.max_uses===undefined&&enrollments.length) need(enrollments[0].device===device,'enrollment_conflict');
        const old=enrollments.find(e=>e.device===device);
        if(old){need(old.expires>t,'enrollment_expired');return enrollmentView(old);}
        need(roster().governance?.state!=='closed','forbidden');
        if(roster().authority_chain)need(p.canonicalize(supplied.payload.authority_chain??null)===p.canonicalize(roster().authority_chain),'forbidden');
        checked(p.verifyInvite(supplied,{lanMode:config.lanMode===true,rootFingerprint:config.rootFingerprint,circle:config.circle,coordinator:config.origin,now:()=>t}));
        const used=invite.consumed_devices??(invite.consumed_by?[invite.consumed_by]:[]);
        need(used.includes(device)||used.length<(supplied.payload.max_uses??1),
          supplied.payload.max_uses===undefined?'enrollment_conflict':'invite_used');
        const e={enrollment_id:freshId('enrollments'),invite_id:id,device,device_public_key:body.device_public_key,enrollment_proof:body.enrollment_proof,state:'pending',created:t,expires:t+DAY};
        if(!used.includes(device)) used.push(device);
        invite.consumed_by??=device;invite.consumed_devices=used;
        put('invites',id,invite);put('enrollments',e.enrollment_id,e);return enrollmentView(e);
      },{bootstrap:body.device_public_key});
    },
    getEnrollment(device,id,ctx) {
      const e=get('enrollments',id);need(e&&e.device===device,'not_found');
      const request=p.strictParse(p.decodeBase64url(ctx.proof)).payload;
      return run('GET','/enrollments/'+id,null,ctx,(_,t)=>{
        const current=get('enrollments',id);need(current.expires>t,'enrollment_expired');
        if(current.state==='approved'&&!p.findMember(roster(),device)) {current.state='rejected';put('enrollments',id,current);}
        return enrollmentView(current);
      },{device,...(request.roster_epoch===0?{bootstrap:e.device_public_key}:{})});
    },
    listEnrollments(device,{state='pending',limit=50,cursor=null}={},ctx) {
      const route='/enrollments?state='+state+'&limit='+limit+(cursor?'&cursor='+encodeURIComponent(cursor):'');
      return run('GET',route,null,ctx,(_,t)=>{
        need(['pending','approved','rejected','expired'].includes(state));
        need(Number.isInteger(limit)&&limit>=1&&limit<=100,'cursor_invalid');
        let snapshot;
        if(cursor){snapshot=get('cursors',cursor);need(snapshot&&snapshot.kind==='enrollments'&&snapshot.device===device&&snapshot.state===state&&snapshot.limit===limit&&snapshot.expires>t,'cursor_invalid');}
        else snapshot={kind:'enrollments',device,state,limit,expires:t+900,ids:all('enrollments').filter(e=>(e.state==='pending'&&e.expires<=t?'expired':e.state)===state).sort((a,b)=>a.created-b.created||a.enrollment_id.localeCompare(b.enrollment_id)).map(e=>e.enrollment_id),position:0};
        const selected=snapshot.ids.slice(snapshot.position,snapshot.position+limit).map(id=>get('enrollments',id));let next_cursor=null;
        if(snapshot.position+limit<snapshot.ids.length){next_cursor=randomUUID();put('cursors',next_cursor,{...snapshot,position:snapshot.position+limit});}
        return {items:selected.map(e=>({enrollment_id:e.enrollment_id,state:e.state==='pending'&&e.expires<=t?'expired':e.state,invite_id:e.invite_id,device_public_key:e.device_public_key,enrollment_proof:e.enrollment_proof,created_at:iso(e.created)})),next_cursor};
      },{device});
    },
    // A member's own signed request to leave. The coordinator only keeps it; the owner's device verifies it and publishes the roster.
    createLeaveRequest(body,ctx) {
      need(body&&typeof body==='object'&&Object.keys(body).length===1&&body.leave!==undefined,'invalid_request');
      const signed=envelope(body.leave);
      return run('POST','/leave-requests',body,ctx,(device,t)=>{
        const v=verify('leave',signed,device);need(v.payload.key_id===device,'forbidden');
        const issued=seconds(v.payload.issued_at);need(issued<=t+60&&issued+30*DAY>t,'invalid_request');
        const old=get('leave_requests',device);
        if(old)return leaveView(old); // one open request per device; an exact retry or a later one returns it
        const l={leave_id:idGenerator(),key_id:device,leave:signed,created:t};
        need(typeof l.leave_id==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(l.leave_id));
        put('leave_requests',device,l);return leaveView(l);
      });
    },
    // A member's reach claim for its own serving origin. The sender is the device the verified request proof names;
    // the coordinator keeps the exact proof beside the body so the publisher can verify the claim without trusting
    // this coordinator's word. It changes no membership, authority or roster. One current claim per device.
    createMemberOrigin(body,ctx) {
      need(body&&typeof body==='object'&&Object.keys(body).length===1&&body.proposal!==undefined,'invalid_request');
      return run('POST','/member-origins',body,ctx,(device,t)=>{
        const v=p.validateMemberOriginProposal(body.proposal,{now:t});checked(v);
        const proposal_digest=p.digest(body.proposal),old=get('member_origins',device);
        // An older claim never replaces a newer one; the newer claim stays the current one.
        if(old&&old.observed>v.observed)return originView(old);
        const m={key_id:device,state:v.state,proposal:body.proposal,proposal_digest,proof:ctx.proof,observed:v.observed,created:t};
        put('member_origins',device,m);return originView(m);
      });
    },
    listMemberOrigins(device,ctx) {
      return run('GET','/member-origins',null,ctx,(_,t)=>{
        need(authorityKeys(roster()).has(device),'forbidden');
        return {items:all('member_origins').filter(m=>p.findMember(roster(),m.key_id))
          .sort((a,b)=>a.created-b.created||a.key_id.localeCompare(b.key_id)).slice(0,100)
          .map(m=>({...originView(m),proposal:m.proposal,proof:m.proof}))};
      },{device});
    },
    listLeaveRequests(device,ctx) {
      return run('GET','/leave-requests',null,ctx,()=>({items:all('leave_requests').filter(l=>p.findMember(roster(),l.key_id))
        .sort((a,b)=>a.created-b.created||a.leave_id.localeCompare(b.leave_id)).slice(0,100).map(l=>({...leaveView(l),leave:l.leave}))}),{device});
    }
  };
  // The owner, steward and co-admins named by the current roster: the devices that may publish a member's origin.
  const authorityKeys=r=>{
    const chain=r.authority_chain?.at(-1)?.payload;
    // Without an authority chain the owner is the device that published the roster (the root key itself never calls).
    return new Set(chain?[chain.owner,chain.steward,...(chain.admins??[])].filter(Boolean).map(k=>k.key_id)
      :[get('circle','config').owner_device,p.fingerprint(r.root_public_key)].filter(Boolean));
  };
  function originView(m) { return {key_id:m.key_id,state:m.state,proposal_digest:m.proposal_digest,created_at:iso(m.created)}; }
  function leaveView(l) { return {leave_id:l.leave_id,key_id:l.key_id,state:'pending',created_at:iso(l.created)}; }
  function enrollmentView(e) {
    return {enrollment_id:e.enrollment_id,invite_id:e.invite_id,device:e.device,state:e.state,created_at:iso(e.created),
      expires_at:iso(e.expires),roster:e.state==='approved'?get('rosters',e.approved_epoch).signed:null};
  }
  api.consumeInvite=(body,ctx)=>api.createEnrollment(body,ctx);
  for(const [name,fn] of Object.entries(api)) if(name!=='close') api[name]=(...args)=>{
    try{return fn(...args);}catch(error){
      if(error instanceof p.ProtocolError)throw error;
      throw new p.ProtocolError('invalid_request');
    }
  };
  return api;
}

/** Local, out-of-band trust bootstrap; never mounted as an HTTP operation. */
export function provisionV1Store({path,provisioning,clock}={}) {
  need(provisioning&&typeof provisioning==='object'&&!Array.isArray(provisioning));
  need(['circle_id','origin','root_fingerprint','roster'].every(k=>Object.hasOwn(provisioning,k)) &&
    Object.keys(provisioning).every(k=>['circle_id','origin','root_fingerprint','roster','lan_mode','quotas'].includes(k)));
  // Optional per-circle limits (R1), fixed when the circle is provisioned.
  need(provisioning.quotas===undefined||(provisioning.quotas&&typeof provisioning.quotas==='object'&&!Array.isArray(provisioning.quotas)&&
    Object.keys(provisioning.quotas).every(k=>Object.hasOwn(DEFAULT_LIMITS,k))));
  need(provisioning.lan_mode === undefined || typeof provisioning.lan_mode === 'boolean');
  need(provisioning.roster?.payload?.epoch===1);
  const verified=checked(p.verifyRoster(provisioning.roster,{circle:provisioning.circle_id,
    rootFingerprint:provisioning.root_fingerprint,now:clock??(()=>Math.floor(Date.now()/1000))}));
  need(verified.payload.epoch===1);
  need((provisioning.lan_mode === true) === (verified.payload.lan_mode === true));
  if (verified.payload.lan_mode) need(verified.payload.coordinator === provisioning.origin);
  checked(p.validateOrigin(provisioning.origin, { lanMode: provisioning.lan_mode === true }));
  need(typeof path==='string');need(!existsSync(path),'conflict');
  mkdirSync(dirname(path),{recursive:true,mode:0o700});
  const store=openV1Store({path,clock,circle:provisioning.circle_id,origin:provisioning.origin,
    rootFingerprint:provisioning.root_fingerprint,initialRoster:provisioning.roster,lanMode:provisioning.lan_mode===true,
    ...(provisioning.quotas?{quotas:provisioning.quotas}:{})});
  store.close();return {circle_id:provisioning.circle_id,origin:provisioning.origin};
}
