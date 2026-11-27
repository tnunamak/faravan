import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { readlink, rename, symlink, unlink } from 'node:fs/promises';
import { acquireProcessLock } from './lock.mjs';

const host = hostname();
const namespace = ['darwin', 'win32'].includes(process.platform) ? process.platform : await readlink('/proc/self/ns/pid').catch(() => null);
const busy = () => Object.assign(new Error('A Git HEAD.lock exists or cannot be checked. Another Git operation may be running. Try again once it finishes. If the lock remains, inspect it and remove it only after confirming no Git process is running.'), { code: 'apply_locked' });

function gone(pid, group = false) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  // Windows does not expose the process-group and namespace proof used here.
  if (process.platform === 'win32') return false;
  try { process.kill(group ? -pid : pid, 0); return false; }
  catch (error) { return error.code === 'ESRCH'; }
}

export const applyOwner = () => ({ host, namespace, pid: process.pid });
export const applyOwnerGone = owner => !!namespace && owner?.host === host && owner.namespace === namespace && gone(owner.pid);

async function recover(path) {
  let record;
  try { record = JSON.parse(await readlink(path)); }
  catch (error) { if (error.code === 'ENOENT') return; throw busy(); }
  if (record?.kind !== 'faravan-apply-head-v1' || record.host !== host ||
      !namespace || record.namespace !== namespace || !gone(record.pid) ||
      (record.writer !== null && !gone(record.writer, true))) throw busy();
  await unlink(path);
}

// The process lock serializes Faravan's reclamation of the shared Git pathname.
export async function acquireApplyHeadLock(head) {
  if (!namespace) throw busy();
  const path = head + '.lock';
  let release;
  try { release = await acquireProcessLock(head + '.faravan-apply', { timeoutMs: 30000 }); }
  catch { throw busy(); }
  try {
    await recover(path);
    const record = { kind: 'faravan-apply-head-v1', host, namespace, pid: process.pid, writer: null, token: randomUUID() };
    try { await symlink(JSON.stringify(record), path); } catch { throw busy(); }
    let current = JSON.stringify(record);
    return {
      async writer(pid) {
        if (!namespace || !Number.isSafeInteger(pid) || pid <= 0) throw busy();
        if (await readlink(path).catch(() => null) !== current) throw busy();
        record.writer = pid;
        const temp = path + '.faravan-' + record.token;
        const next = JSON.stringify(record);
        await symlink(next, temp);
        await rename(temp, path);
        current = next;
      },
      async release() {
        try {
          const found = await readlink(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
          if (found === current) await unlink(path);
          else if (found !== null) throw busy();
        } finally { release(); }
      },
    };
  } catch (error) { release(); throw error; }
}

export async function recoverApplyHeadLock(head) {
  let release;
  try {
    release = await acquireProcessLock(head + '.faravan-apply', { timeoutMs: 0 });
    await recover(head + '.lock');
  } catch { /* An active or unknown owner is left untouched. */ }
  finally { try { release?.(); } catch { /* Recovery must not prevent startup. */ } }
}
