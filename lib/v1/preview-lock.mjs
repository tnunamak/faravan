import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { link, lstat, mkdir, open, readFile, readlink, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireProcessLock, macIdentity } from './lock.mjs';

const blocked = path => Object.assign(new Error(`Git lock ${path} is occupied. Another Git operation may be running. Try again once it finishes, or use Recover preview locks to check for a stopped Faravan owner.`), {code:'preview_lock_blocked'});

async function identity(pid, {platformName=process.platform,identityReader=macIdentity}={}) {
  if(platformName==='darwin') {
    try {return {host:hostname(),namespace:'darwin',pid,...identityReader(pid)};} catch {return null;}
  }
  if (process.platform !== 'linux') return null;
  try {
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    const machine = (await readFile('/etc/machine-id', 'utf8')).trim();
    const namespace = await readlink('/proc/self/ns/pid');
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(') ') + 2).trim().split(/\s+/);
    if (!boot || !machine || !/^\d+$/.test(fields[19] ?? '')) return null;
    return { host:hostname(), machine, boot, namespace, pid, start:fields[19], state:fields[0] };
  } catch { return null; }
}

async function gone(owner, options={}) {
  const {platformName=process.platform,identityReader=macIdentity,processKill=process.kill}=options;
  if(platformName==='darwin') {
    if(owner?.version!==1||owner.host!==hostname()||owner.namespace!=='darwin'||
      !Number.isSafeInteger(owner.pid)||owner.pid<1||!/^darwin:\d+$/.test(owner.boot??'')||
      !/^\d+$/.test(owner.start??'')||!/^[0-9a-f-]{36}$/.test(owner.token??''))return false;
    try {
      if(owner.childGroup!==undefined) {
        if(!Number.isSafeInteger(owner.childGroup)||owner.childGroup<1)return false;
        try {processKill(-owner.childGroup,0);return false;} catch(error){if(error.code!=='ESRCH')return false;}
      }
      try {processKill(owner.pid,0);} catch(error){if(error.code==='ESRCH')return true;if(error.code!=='EPERM')return false;}
      const current=identityReader(owner.pid);
      return !!current?.boot&&!!current?.start&&(current.boot!==owner.boot||current.start!==owner.start);
    } catch {return false;}
  }
  if (process.platform !== 'linux' || owner?.version !== 1 || owner.host !== hostname() ||
      !Number.isSafeInteger(owner.pid) || owner.pid < 1 || !/^\d+$/.test(owner.start ?? '') ||
      typeof owner.boot !== 'string' || !owner.boot || typeof owner.namespace !== 'string' ||
      typeof owner.machine !== 'string' || !owner.machine || !/^[0-9a-f-]{36}$/.test(owner.token ?? '')) return false;
  try {
    if ((await readFile('/etc/machine-id', 'utf8')).trim() !== owner.machine) return false;
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (boot !== owner.boot) return true;
    if (await readlink('/proc/self/ns/pid') !== owner.namespace) return false;
    if (owner.childGroup !== undefined) {
      if (!Number.isSafeInteger(owner.childGroup) || owner.childGroup < 1) return false;
      try { process.kill(-owner.childGroup, 0); return false; }
      catch (error) { if (error.code !== 'ESRCH') return false; }
    }
    const current = await identity(owner.pid);
    if (current) return current.start !== owner.start || current.state === 'Z';
    try { process.kill(owner.pid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  } catch { return false; }
}

// Publish the Git process group before sending its transaction. If the app
// dies, recovery waits until both it and the Git process group have stopped.
export async function recordTransaction(path, childGroup, stagingDir) {
  if (!['linux','darwin'].includes(process.platform)) return;
  const owner = JSON.parse(await readFile(path, 'utf8'));
  await mkdir(stagingDir, {recursive:true});
  const staging = join(stagingDir, `${randomUUID()}.faravan`);
  let fd;
  try {
    fd = await open(staging, 'wx', 0o600);
    await fd.writeFile(JSON.stringify({...owner, childGroup}));
    await fd.sync();
    await fd.close(); fd = null;
    await rename(staging, path);
  } finally {
    if (fd) await fd.close();
    await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function previewGuard(commonDir, {timeoutMs = 250} = {}) {
  try { return await acquireProcessLock(`${commonDir}/faravan-preview-guard`, {timeoutMs}); }
  catch { throw blocked(`${commonDir}/faravan-preview-guard`); }
}

export async function acquirePreviewLock(path, stagingDir, options={}) {
  const id = await identity(process.pid,options);
  const record = JSON.stringify({version:1, ...id, token:randomUUID()});
  await mkdir(stagingDir, {recursive:true});
  const staging = join(stagingDir, `${randomUUID()}.faravan`);
  let fd;
  try {
    fd = await open(staging, 'wx', 0o600);
    await fd.writeFile(record);
    await fd.sync();
    await fd.close(); fd = null;
    await link(staging, path);
  } catch (error) {
    if (error.code === 'EEXIST') throw blocked(path);
    throw error;
  } finally {
    if (fd) await fd.close();
    await unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  return async () => { await unlink(path); };
}

// The guard serializes all Faravan acquisitions and recoveries in this repository.
// Native Git never removes an existing lock it did not acquire.
export async function recoverPreviewLock(path, options={}) {
  let before, text;
  try {
    before = await lstat(path);
    if (!before.isFile() || before.isSymbolicLink()) throw blocked(path);
    text = await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  let owner;
  try { owner = JSON.parse(text); } catch { throw blocked(path); }
  if (!await gone(owner,options)) throw blocked(path);
  const after = await lstat(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (!after || before.dev !== after.dev || before.ino !== after.ino || text !== await readFile(path, 'utf8')) throw blocked(path);
  await unlink(path);
}
