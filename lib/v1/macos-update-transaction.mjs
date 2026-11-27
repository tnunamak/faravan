// Filesystem half of a packaged update. The caller owns process identity,
// verified staging, admission exclusion, and authenticated readiness.
import {randomUUID} from 'node:crypto';
import {lstat, realpath, readFile, rename as fsRename, open, access, rm} from 'node:fs/promises';
import {dirname, basename, isAbsolute, resolve, join} from 'node:path';
import {durableJsonAsync} from '../durable-write.mjs';
import {acquireProcessLock} from './lock.mjs';

const fail = (code, message) => Object.assign(new Error(message), {code});
const missing = error => error.code === 'ENOENT';
async function stat(path) { try { return await lstat(path); } catch (e) { if (missing(e)) return null; throw e; } }
async function syncDir(path) { const fd = await open(path, 'r'); try { await fd.sync(); } finally { await fd.close(); } }

export function createMacBundleTransaction({appPath, journalPath, version, previousVersion,
  verifyBundle, quiescent, launch, waitReady, stopOwnedLaunch, isNewer, exchange, home, channel, bundleId, lockGuard, remove = rm, rename = fsRename, afterRename = async () => {}}) {
  if (!isAbsolute(appPath ?? '') || resolve(appPath) !== appPath || !basename(appPath).endsWith('.app') ||
      !isAbsolute(journalPath ?? '') || resolve(journalPath) !== journalPath || dirname(journalPath) !== dirname(appPath) ||
      !version || !previousVersion || version === previousVersion ||
      [verifyBundle, quiescent, launch, waitReady, stopOwnedLaunch, isNewer, exchange].some(f => typeof f !== 'function'))
    throw fail('invalid_identity', 'Invalid transaction identity or callbacks');
  const parent = dirname(appPath), next = appPath + '.next', prev = appPath + '.previous', lock = appPath + '.update.lock';
  if ([appPath, next, prev, lock, lock + '.owners-v1'].includes(journalPath)) throw fail('invalid_identity', 'Invalid journal path');
  const uid = process.getuid?.();
  async function owned(path, type, required = true) {
    const s = await stat(path);
    if (!s) { if (required) throw fail('invalid_layout', 'Missing transaction path: ' + path); return false; }
    if (s.isSymbolicLink() || (type === 'directory' ? !s.isDirectory() : !s.isFile()) || (uid !== undefined && s.uid !== uid))
      throw fail('invalid_layout', 'Unowned or invalid transaction path: ' + path);
    return true;
  }
  async function validateParent() {
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || (uid !== undefined && ![uid, 0].includes(parentStat.uid)))
      throw fail('invalid_layout', 'Untrusted parent directory');
    await access(parent, 3);
    if (await realpath(parent) !== parent) throw fail('invalid_layout', 'Parent path is not canonical');
    await owned(journalPath, 'file', false);
  }
  async function verified(path, expected) {
    await owned(path, 'directory');
    if (await verifyBundle(path, expected) !== true) throw fail('invalid_bundle', 'Bundle identity verification failed');
  }
  async function idle() { if (await quiescent() !== true) throw fail('not_quiescent', 'Process ownership or cessation is not established'); }
  async function save(journal, phase) { journal.phase = phase; await durableJsonAsync(journalPath, journal); }
  async function move(from, to, phase) {
    if (await stat(to)) throw fail('invalid_layout', 'Rename destination exists');
    await rename(from, to); await syncDir(parent); await afterRename(phase);
  }
  async function readJournal() {
    if (!await owned(journalPath, 'file', false)) return null;
    let j; try { j = JSON.parse(await readFile(journalPath, 'utf8')); } catch { throw fail('invalid_journal', 'Unreadable transaction journal'); }
    if (!j || j.schema !== 1 || j.appPath !== appPath || typeof j.version !== 'string' || typeof j.previousVersion !== 'string' ||
        !/^[0-9a-f-]{36}$/.test(j.id ?? '') || !['prepared','exchanging','retaining','starting','rollback-exchanging','rollback-retaining','restarting-old','rolled-back','committed'].includes(j.phase))
      throw fail('invalid_journal', 'Journal does not match this transaction');
    return j;
  }
  async function locked(work) {
    await validateParent();
    if(lockGuard) return lockGuard(async()=>{await validateParent();return work();});
    const release = await acquireProcessLock(lock, {timeoutMs: 0});
    try { await validateParent(); return await work(); } finally { release(); }
  }
  async function swap(other, phase) {
    await exchange(appPath,other); await syncDir(parent); await afterRename(phase);
  }
  async function rollback(j, handle) {
    if (handle !== undefined && await stopOwnedLaunch(handle) !== true) throw fail('ownership_unknown', 'Candidate cessation is not established');
    await idle();
    await owned(appPath, 'directory');
    const isOld=await verifyBundle(appPath,previousVersion), isNew=await verifyBundle(appPath,version);
    if (isOld===isNew) throw fail('invalid_layout','Installed bundle identity is ambiguous');
    const hasPrev=await owned(prev,'directory',false), hasNext=await owned(next,'directory',false);
    if (isNew) {
      if (hasPrev===hasNext) throw fail('invalid_layout','Previous bundle location is ambiguous');
      const old=hasPrev?prev:next;
      await verified(old,previousVersion);
      await save(j,'rollback-exchanging'); await swap(old,'rollback-exchanging');
      if (old===prev) { await save(j,'rollback-retaining'); await move(prev,next,'rollback-retaining'); }
    } else {
      await verified(appPath,previousVersion);
      if (hasPrev && hasNext) throw fail('invalid_layout','Unexpected rollback siblings');
      if (hasPrev) {await verified(prev,version);await save(j,'rollback-retaining');await move(prev,next,'rollback-retaining');}
      else if (hasNext) await verified(next,version);
    }
    await save(j,'restarting-old');
    const oldHandle=await launch(appPath,{version:previousVersion,transactionId:j.id,rollback:true});
    if(oldHandle==null)throw fail('ownership_unknown','Old launcher did not return an owned handle');
    const ready=await waitReady(oldHandle,{appPath,version:previousVersion,transactionId:j.id,rollback:true});
    if(!ready||ready.appPath!==appPath||ready.version!==previousVersion||ready.transactionId!==j.id||ready.authenticated!==true)
      throw fail('old_not_ready','Restored app did not acknowledge its identity');
    await save(j,'rolled-back'); return 'rolled-back';
  }
  // The read-only half of apply: every refusal that depends only on the journal
  // and the sibling bundle layout. The helper runs it before it acknowledges
  // readiness, while the old app is still running, so nothing is stopped for an
  // update that apply would refuse. `bundles` adds the (slow) signature checks.
  async function inspect({bundles}) {
    const existing = await readJournal();
    let retire = null, hasPrev;
    if (existing) {
      if (!['rolled-back', 'committed'].includes(existing.phase)) throw fail('recovery_required', 'Transaction requires recovery');
      const current = existing.phase === 'committed' ? existing.version : existing.previousVersion;
      if (previousVersion !== current || isNewer(version, existing.version) !== true)
        throw fail(existing.phase === 'rolled-back' ? 'failed_version' : 'invalid_version', 'Candidate does not advance the recorded version');
      if (bundles) await verified(appPath, current); else await owned(appPath, 'directory');
      if (existing.phase === 'committed' && (hasPrev = await owned(prev, 'directory', false))) {
        const identity = await lstat(prev), saved = existing.retiringPrevious;
        if (saved) { if (saved.dev !== identity.dev || saved.ino !== identity.ino) throw fail('invalid_layout', 'Previous bundle was replaced during cleanup'); }
        else if (bundles) await verified(prev, existing.previousVersion);
        retire = {existing, identity};
      }
    }
    hasPrev ??= await owned(prev, 'directory', false);
    if (hasPrev && !retire) throw fail('invalid_layout', 'Previous bundle already exists');
    if (bundles) { await verified(appPath, previousVersion); await verified(next, version); }
    else { await owned(appPath, 'directory'); await owned(next, 'directory'); }
    return retire;
  }
  async function preflight() { await validateParent(); await inspect({bundles: false}); }
  async function apply() {
    let mutating = false;
    try { return await locked(async () => {
      const retire = await inspect({bundles: true});
      if (retire) {
        const {existing, identity} = retire;
        if (!existing.retiringPrevious) { existing.retiringPrevious = {dev: identity.dev, ino: identity.ino}; await save(existing, 'committed'); }
        await remove(prev, {recursive:true}); await syncDir(parent);
      }
      await idle();
      const j = {schema: 1, id: randomUUID(), appPath, version, previousVersion, phase: 'prepared', ...(home&&channel&&bundleId?{home,channel,bundleId}:{})};
      mutating = true;
      await save(j, 'prepared');
      let handle;
      try {
        await save(j, 'exchanging'); await swap(next, 'exchanging');
        await save(j, 'retaining'); await move(next, prev, 'retaining');
        await save(j, 'starting');
        handle = await launch(appPath, {version, transactionId: j.id, rollback: false});
        if (handle == null) throw fail('ownership_unknown', 'Launch did not return an owned handle');
        const ready = await waitReady(handle, {appPath, version, transactionId: j.id});
        if (!ready || ready.appPath !== appPath || ready.version !== version || ready.transactionId !== j.id || ready.authenticated !== true)
          throw fail('not_ready', 'Candidate did not acknowledge its identity');
        await save(j, 'committed'); return 'committed';
      } catch (error) {
        // Tests may model process death; no catch/rollback can run after real death.
        if (error?.simulatedCrash === true) throw error;
        await rollback(j, handle); throw error;
      }
    }); } catch (error) {
      // A refusal before the first journal write leaves the installed app exactly
      // as it was, so the caller may start it again.
      if (!mutating && error && typeof error === 'object' && error.simulatedCrash !== true) error.refused = true;
      throw error;
    }
  }
  async function recover() { return locked(async () => {
    const j = await readJournal();
    if (!j) return 'none';
    if (j.phase === 'committed' || j.phase === 'rolled-back') return j.phase;
    if (j.version !== version || j.previousVersion !== previousVersion) throw fail('invalid_journal', 'Recovery identity does not match journal');
    // A prior process's launch handle is not transferable. quiescent must establish
    // cessation from durable identity, not merely absence of an in-memory handle.
    return rollback(j, undefined);
  }); }
  return {apply, recover, preflight};
}
