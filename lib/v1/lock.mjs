// Process-owned local filesystem locks. Never unlink a reusable lock pathname:
// immutable UUID entries form a Lamport bakery, so concurrent crash recovery
// cannot remove a replacement owner's lock. This is for a local filesystem.
import fs from 'node:fs';
import path from 'node:path';
import {hostname} from 'node:os';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';
import {AsyncLocalStorage} from 'node:async_hooks';
import {readWindowsProcessCreationIdentity} from './windows-process.mjs';

const suffix = '.owners-v1';
// A sibling gate exists independently of the profile, so initialization and
// migration also exclude each other when the profile does not exist yet.
export function profileWriterLockPath(home) {
  function canonical(file) {
    const parent=path.dirname(file);
    if(parent===file)return file;
    const entry=path.join(canonical(parent),path.basename(file));
    let st;
    try {st=fs.lstatSync(entry);} catch(error) {if(error.code==='ENOENT')return entry;throw error;}
    return st.isSymbolicLink()?fs.realpathSync(entry):entry;
  }
  return canonical(path.resolve(home))+'.profile-write.lock';
}
const profileWriters = new AsyncLocalStorage();
/** Share one gate across nested device and metadata writes to the same profile. */
export async function withProfileWriter(home, work, options = {}) {
  const lock = profileWriterLockPath(home), inherited = profileWriters.getStore();
  if (inherited?.get(lock)?.active) return work();
  const release = await acquireProcessLock(lock, options), owner = {active:true};
  const context = new Map(inherited);
  context.set(lock, owner);
  try { return await profileWriters.run(context, work); }
  finally { owner.active = false; release(); }
}
const busy = (message='Process lock is busy or its owner is unknown') => Object.assign(new Error(message), {code:'lock_busy'});
// Retain lock_busy for generic lock callers; coordinators expose the distinct reason as an error code.
const stale = message => Object.assign(new Error(
  'Process lock looks stale or cannot be verified: ' + message +
  '. Unverified entries were preserved. Stop automatic restarts and verify no owner uses this home ' +
  '(including the recorded host/PID namespace) before manually clearing only the indicated lock entries.'),
  {code:'lock_busy',reason:'lock_stale'});
const missing = error => error.code === 'ENOENT';
const windowsCreationIdentity = value => typeof value === 'string' && /^\/Date\(\d+\)\/$/.test(value);
const host = hostname();
const namespace = (()=>{try {return fs.readlinkSync('/proc/self/ns/pid');} catch {return null;}})();
const ownWindowsIdentities = new WeakMap();
function ownWindowsIdentity(identityReader) {
  let byPid = ownWindowsIdentities.get(identityReader);
  if (!byPid) { byPid = new Map(); ownWindowsIdentities.set(identityReader,byPid); }
  if (byPid.has(process.pid)) return byPid.get(process.pid);
  // Keep successful identities only. A transient probe failure must not disable identity checks for this process forever.
  let identity = null;
  try { identity = identityReader(process.pid); } catch { /* A later bounded probe may succeed. */ }
  if (!windowsCreationIdentity(identity)) identity = null;
  if (identity !== null) byPid.set(process.pid,identity);
  return identity;
}
function linuxIdentity(pid) {
  const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
  const stat = fs.readFileSync('/proc/'+pid+'/stat','utf8');
  const fields = stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
  if (!boot || !/^\d+$/.test(fields[19] ?? '')) throw busy();
  return {boot,start:fields[19],state:fields[0]};
}
export function macIdentity(pid) {
  const options={encoding:'utf8',timeout:1000,env:{...process.env,LC_ALL:'C',TZ:'UTC'},stdio:['ignore','pipe','ignore']};
  const boot=/sec\s*=\s*(\d+)/.exec(execFileSync('/usr/sbin/sysctl',['-n','kern.boottime'],options))?.[1];
  const output=execFileSync('/bin/ps',['-p',String(pid),'-o','lstart='],options).trim();
  const start=Date.parse(output+' UTC');
  if(!boot||!Number.isSafeInteger(start)||start<=0)throw busy();
  return {boot:'darwin:'+boot,start:String(start)};
}
const ownPosixIdentities = new WeakMap();
function cachedPosixIdentity(reader) {
  return (pid, platform) => {
    if (platform === 'win32' || pid !== process.pid) return reader(pid, platform);
    // Our start identity cannot change while this module is alive. Never cache
    // another process: its PID may be reused between lock acquisitions.
    let platforms = ownPosixIdentities.get(reader);
    if (!platforms) { platforms = new Map(); ownPosixIdentities.set(reader, platforms); }
    const cached = platforms.get(platform);
    if(cached)return cached;
    const identity=reader(pid,platform);
    if(typeof identity?.boot!=='string'||!identity.boot.length||typeof identity.start!=='string'||!/^\d+$/.test(identity.start))
      throw busy('Own process start identity is unavailable');
    // Only successful observations are cached; acquisition bounds failed probes.
    platforms.set(platform,identity);
    return identity;
  };
}
const posixIdentity = (pid, platform) => platform === 'darwin' ? macIdentity(pid) : linuxIdentity(pid);
function owner(platform,identityReader,posixIdentityReader) {
  for(let probe=0;probe<3;probe++) {
    try {
      const identity=platform==='win32'?{boot:null,start:ownWindowsIdentity(identityReader)}:posixIdentityReader(process.pid,platform);
      if(platform==='win32'&&!windowsCreationIdentity(identity.start))continue;
      return {version:1,host,namespace:platform==='win32'?null:namespace,
        pid:process.pid,boot:identity.boot,start:identity.start,token:randomUUID()};
    }catch{/* A transient identity failure may succeed on the next bounded probe. */}
  }
  throw Object.assign(new Error('Faravan could not verify this process start identity. Please try again.'),
    {code:'lock_identity_unavailable',retryable:true});
}
function isGone(record,platform,{identityReader,processKill,posixIdentityReader=posixIdentity}={}) {
  // PID observations only describe this host and PID namespace. Unknown is not dead.
  if (record.host !== host || record.namespace !== (platform === 'win32' ? null : namespace))
    throw stale('Process lock owner belongs to an unverifiable host or PID namespace');
  try { processKill(record.pid,0); }
  catch (error) {
    if (error.code === 'ESRCH') return true;
    // EPERM means the PID exists, not that it is still this owner. Read identity below.
    if (error.code !== 'EPERM') throw stale('Process lock owner liveness cannot be read');
  }
  if (platform === 'win32') {
    if (!windowsCreationIdentity(record.start))
      throw stale('Process lock owner creation identity is unavailable or incompatible');
    let current;
    try {
      current = record.pid === process.pid ? ownWindowsIdentity(identityReader) : identityReader(record.pid);
    } catch {
      throw stale('Process lock owner creation identity cannot be read');
    }
    if (!windowsCreationIdentity(current)) throw stale('Process lock owner creation identity cannot be read');
    return current !== record.start;
  }
  let current;
  try { current = posixIdentityReader(record.pid,platform); }
  catch {
    // It may have exited between the probe and identity read.
    try { processKill(record.pid,0); }
    catch (error) { if (error.code === 'ESRCH') return true; }
    throw stale('Process lock owner start identity cannot be read');
  }
  if (!record.boot || !current?.boot || typeof current.start !== 'string' || !/^\d+$/.test(current.start))
    throw stale('Process lock owner start identity is unavailable or incompatible');
  // macOS boot time follows wall-clock adjustments; matching starts cannot prove a reboot.
  if (platform === 'darwin' && current.boot !== record.boot && current.start === record.start)
    throw stale('Process lock owner boot time changed with an unchanged start identity');
  return current.boot !== record.boot || current.start !== record.start || current.state === 'Z';
}
// Linux process-start identity for durable external-writer leases. Other
// platforms cannot establish this identity through /proc and must refuse.
export function writerIdentity(pid) {
  const identity = linuxIdentity(pid);
  if (!namespace || !identity.boot) throw busy();
  return {version:1,host,namespace,pid,boot:identity.boot,start:identity.start};
}
export function writerGroupGone(record) {
  if (!record || record.version !== 1 || record.host !== host || record.namespace !== namespace ||
      !Number.isSafeInteger(record.pid) || record.pid <= 0 || typeof record.boot !== 'string' ||
      !/^\d+$/.test(record.start ?? '')) return false;
  try {
    if (fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim() !== record.boot) return true;
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      let stat;
      try { stat = fs.readFileSync('/proc/'+entry+'/stat','utf8'); }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') continue; return false; }
      const fields = stat.slice(stat.lastIndexOf(') ')+2).trim().split(/\s+/);
      if (fields[2] === String(record.pid) && fields[0] !== 'Z') return false;
    }
    // A writer can fork after the directory snapshot. Only the kernel can
    // establish that the process group no longer exists at the end of the scan.
    try { process.kill(-record.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  } catch { return false; }
}
function unlink(file) {
  try { fs.unlinkSync(file); } catch (error) { if (!missing(error)) throw error; }
}
function validOwner(value,token,platform) {
  return value?.version === 1 && value.token === token &&
    typeof value.host === 'string' && (value.namespace === null || typeof value.namespace === 'string') &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    (value.boot === null || typeof value.boot === 'string' && value.boot.length > 0) &&
    typeof value.start === 'string' && (platform === 'win32' ? value.start.length > 0 : /^\d+$/.test(value.start));
}
function recordText(file,platform) {
  if (platform !== 'win32') return fs.readlinkSync(file);
  const fd=fs.openSync(file,'r');
  try {
    if (!fs.fstatSync(fd).isFile()) throw busy();
    return fs.readFileSync(fd,'utf8');
  } finally { fs.closeSync(fd); }
}
function publishRecord(file,value,platform) {
  const text=JSON.stringify(value);
  if (platform !== 'win32') { fs.symlinkSync(text,file); return; }
  const staging=file+'.staging';
  let fd,created=false;
  try {
    fd=fs.openSync(staging,'wx',0o600);created=true;
    fs.writeFileSync(fd,text);
    fs.fsyncSync(fd);
    fs.closeSync(fd);fd=undefined;
    // The UUID path is unique. Publish only after the complete record is durable.
    fs.renameSync(staging,file);created=false;
  } catch (error) {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    if (created) unlink(staging);
    throw error;
  }
}
function inspect(directory,platform,identityOptions,ignoreToken) {
  const entries=[],tokens=new Set();
  for (const name of fs.readdirSync(directory)) {
    if (/^[0-9a-f-]{36}\.(choosing|ticket)\.staging$/.test(name)) continue;
    const match=/^([0-9a-f-]{36})\.(choosing|ticket)$/.exec(name);
    if (!match) throw stale(`Unknown process lock entry: ${path.join(directory,name)}. Stop all versions and reconcile manually; the entry was preserved.`);
    tokens.add(match[1]);
  }
  for (const token of tokens) {
    if (token === ignoreToken) continue;
    const registration=path.join(directory,token+'.choosing'),ticket=path.join(directory,token+'.ticket');
    let value;
    // Never infer absence from an incomplete scan during another owner's exit.
    try { value=JSON.parse(recordText(registration,platform)); }
    catch (error) {
      // A registration can disappear after the directory snapshot during release.
      // Malformed/permission-denied records are not transient contention.
      throw Object.assign(stale(`Unreadable process lock owner: ${registration}; refusing automatic takeover`),
        {retryable:missing(error)});
    }
    if (!validOwner(value,token,platform) || value.ticket !== undefined) throw stale(`Invalid process lock owner: ${registration}; refusing automatic takeover`);
    let gone;
    try { gone=isGone(value,platform,identityOptions); }
    catch (error) { error.message += `: ${registration}; refusing automatic takeover`; throw error; }
    let selected;
    // Registration stays present throughout selection and ownership. Look up
    // its ticket directly even if publication happened after readdir's snapshot.
    try { selected=JSON.parse(recordText(ticket,platform)); }
    catch (error) {
      if (missing(error)) {
        if (gone) { unlink(registration); continue; }
        entries.push({...value,choosing:true});continue;
      }
      throw stale(`Unreadable process lock ticket: ${ticket}; refusing automatic takeover`);
    }
    if (!validOwner(selected,token,platform) || !/^[1-9]\d{0,99}$/.test(selected.ticket ?? '') ||
        ['version','host','namespace','pid','boot','start','token'].some(key=>selected[key]!==value[key])) throw stale(`Invalid process lock ticket: ${ticket}; refusing automatic takeover`);
    if (gone) { unlink(ticket);unlink(registration);continue; }
    entries.push({...selected,choosing:false});
  }
  return entries;
}
function syncDirectory(directory,platform) {
  if (platform === 'win32') return;
  const fd=fs.openSync(directory,'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
/**
 * Acquire immediately or throw lock_busy. Release is idempotent and synchronous.
 * durable:false skips the directory fsync on acquire and release. Use it only when the caller
 * writes nothing under the lock; mutual exclusion does not depend on that fsync.
 */
export function acquireProcessLockSync(lockPath,{platform=process.platform,
  identityReader=readWindowsProcessCreationIdentity,processKill=process.kill,posixIdentityReader=posixIdentity,durable=true}={}) {
  posixIdentityReader = cachedPosixIdentity(posixIdentityReader);
  // Legacy owner files/directories do not establish process start identity.
  // Preserve them for explicit operator reconciliation, never guess their age.
  try { fs.lstatSync(lockPath); throw stale(`Unknown legacy process lock: ${lockPath}; refusing automatic takeover`); }
  catch (error) { if (!missing(error)) throw error; }
  const directory = lockPath+suffix;
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const st=fs.lstatSync(directory);
  if (!st.isDirectory() || st.isSymbolicLink()) throw stale(`Invalid process lock directory: ${directory}; refusing automatic takeover`);
  const record=owner(platform,identityReader,posixIdentityReader), choosing=path.join(directory,record.token+'.choosing'),
    ticket=path.join(directory,record.token+'.ticket');
  let choosingCreated=false,ticketCreated=false;
  try {
    // POSIX symlinks publish complete records atomically. Windows has no
    // unprivileged symlink creation, so publish an exclusive, synced file.
    publishRecord(choosing,record,platform); choosingCreated=true;
    const previous=inspect(directory,platform,{identityReader,processKill,posixIdentityReader},record.token);
    const number=previous.reduce((max,e)=>e.choosing?max:(BigInt(e.ticket)>max?BigInt(e.ticket):max),0n)+1n;
    if (number.toString().length>100) throw busy();
    publishRecord(ticket,{...record,ticket:String(number)},platform); ticketCreated=true;
    // Keep the registration stable until release: publication must not move
    // the participant between directory entries during a competing scan.
    // A late registrant omitted by this admission scan must observe our
    // already-published ticket in its subsequent number scan and choose higher.
    // Existing registrations remain enumerable until their owners leave.
    for (const entry of inspect(directory,platform,{identityReader,processKill,posixIdentityReader},record.token)) {
      if (entry.token===record.token) continue;
      if (entry.choosing || BigInt(entry.ticket)<number ||
          BigInt(entry.ticket)===number && entry.token<record.token)
        throw busy(`Process lock is held by a verified live owner: ${path.join(directory,entry.token+'.choosing')}; refusing automatic takeover`);
    }
    if (durable) syncDirectory(directory,platform);
    let released=false;
    return () => {
      if (released) return;
      // Paths contain this acquisition's never-reused UUID. No shared owner
      // pathname is deleted, including during concurrent stale-owner cleanup.
      unlink(ticket); unlink(choosing); if (durable) syncDirectory(directory,platform); released=true;
    };
  } catch (error) {
    if (ticketCreated) unlink(ticket);
    if (choosingCreated) unlink(choosing);
    throw error;
  }
}
/** A bounded contention wait (250 ms unless the caller sets timeoutMs); a timeout never steals a live/unknown lock. */
export async function acquireProcessLock(lockPath,{timeoutMs=250,pollMs=10,signal,platform=process.platform,
  identityReader=readWindowsProcessCreationIdentity,processKill=process.kill,posixIdentityReader=posixIdentity,
  now=()=>performance.now(),sleep:wait=sleep}={}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs<0 || !Number.isFinite(pollMs) || pollMs<=0)
    throw new TypeError('Invalid process lock wait');
  const deadline=now()+timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try { return acquireProcessLockSync(lockPath,{platform,identityReader,processKill,posixIdentityReader}); }
    catch (error) {
      if (error.code!=='lock_busy' || error.reason==='lock_stale' && !error.retryable || now()>=deadline) throw error;
      await wait(Math.min(pollMs,Math.max(1,deadline-now())),undefined,{signal});
    }
  }
}

// The coordinator owns this gate independently of its launcher's host-v1 gate.
export const coordinatorProcessLockPath = home => path.join(home, 'coordinator-v1');
function coordinatorLockError(error,home) {
  if (error.reason === 'lock_stale') {
    const lock = coordinatorProcessLockPath(home);
    return Object.assign(new Error(
      'The coordinator lock looks stale or cannot be verified: ' + error.message +
      '. Lock path: ' + lock + suffix + ' (legacy path: ' + lock + '). ' +
      'Unverified entries were preserved. Disable automatic restarts and verify that no coordinator uses this home, ' +
      'including on the recorded host or PID namespace, before manually clearing the indicated lock entries. ' +
      'Preserve all other home data, then restart hosting.'),
      {code:'coordinator_stale_lock',cause:error});
  }
  if (error.code === 'lock_busy')
    return Object.assign(new Error('A coordinator already owns this home. Stop that coordinator before starting another.'),
      {code:'coordinator_already_running',cause:error});
  return error;
}
// Preserve the synchronous API for callers requiring immediate admission.
export function acquireCoordinatorProcessLock(home,options={}) {
  try { return acquireProcessLockSync(coordinatorProcessLockPath(home),options); }
  catch (error) { throw coordinatorLockError(error,home); }
}
// Match the host resume budget without importing host.mjs and its process dependencies.
export const COORDINATOR_LOCK_WAIT_MS = 10000;
export async function acquireCoordinatorProcessLockWait(home,options={}) {
  try { return await acquireProcessLock(coordinatorProcessLockPath(home),
    {timeoutMs:COORDINATOR_LOCK_WAIT_MS,...options}); }
  catch (error) { throw coordinatorLockError(error,home); }
}

/** Validated live registrations, not permission to adopt or signal their PIDs. */
export function processLockOwners(lockPath) {
  try { fs.lstatSync(lockPath); throw stale(`Unknown legacy process lock: ${lockPath}; refusing automatic takeover`); }
  catch (error) { if (!missing(error)) throw error; }
  const directory = lockPath + suffix;
  let st;
  try { st = fs.lstatSync(directory); }
  catch (error) { if (missing(error)) return []; throw error; }
  if (!st.isDirectory() || st.isSymbolicLink()) throw stale(`Invalid process lock directory: ${directory}; refusing automatic takeover`);
  let entries;
  // A snapshot can race a normal release. Rescan the whole directory rather
  // than treating an incomplete observation as proof of an absent owner.
  for (let attempt=0;;attempt++) {
    try {
      entries = inspect(directory, process.platform, {identityReader:readWindowsProcessCreationIdentity, processKill:process.kill});
      break;
    } catch (error) {
      if (error.reason!=='lock_stale' || error.retryable!==true || attempt>=2) throw error;
    }
  }
  if (entries.some(entry => entry.host !== host || entry.namespace !== (process.platform === 'win32' ? null : namespace)))
    throw busy('Process lock belongs to an unknown observation domain');
  return entries;
}

/** True only when `lockPath` is held by `pid`. A saved PID alone is no proof: a number outlives its process. An unreadable lock is no proof. */
export function lockHeldBy(lockPath, pid) {
  try { return processLockOwners(lockPath).some(owner => owner.pid === pid); } catch { return false; }
}
