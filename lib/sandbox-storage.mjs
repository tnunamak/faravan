import { mkdir, readFile, open, rename, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquireProcessLock } from './v1/lock.mjs';

export const STORAGE_BLOCKED = 'Cannot lend: host storage protection is unavailable. Guest block-device capacity does not limit host runtime storage.';
const MiB = 1048576;
// This layout was exercised on Linux with sbx 0.49.2. Other runtime layouts
// must be qualified before they can supply storage evidence.
export const storageRuntimeSupported = (version, platform = process.platform) =>
  platform === 'linux' && /(?:^|\s)v?0\.49\.2(?:\s|$)/.test(version);
export function storageVolumes(bytes, image = 'shell') {
  // Claude 0.49.2 also mounts projects (2 GiB) and four 512 MiB state
  // volumes. Codex and shell have no additional writable disks.
  const kit = image === 'claude' ? [2048,512,512,512,512].map(n=>n*MiB) : [];
  const overhead = kit.reduce((a,b)=>a+b,0);
  if (!['claude','codex','shell'].includes(image) || !Number.isSafeInteger(bytes) || bytes % MiB || bytes < overhead + 1024 * MiB)
    throw Object.assign(new Error(STORAGE_BLOCKED), { code: 'storage_unenforceable' });
  return { root: bytes - overhead - 512 * MiB, docker: 512 * MiB, kit };
}
const fail = () => Object.assign(new Error(STORAGE_BLOCKED), { code: 'storage_unenforceable' });

/** Durable aggregate admission reservation. Keep all reserved bytes charged
 * until independent VM-removal proof; a process crash cannot refund capacity. */
export function createStoragePool({ home, run, platform = process.platform, freeBytes = async () => {
  const fs = await statfs(home()); return fs.bavail * fs.bsize;
} }) {
  const file = () => join(home(), 'storage-reservations.json');
  const qualification = () => join(home(), 'storage-qualification.json');
  const supported = async version => {
    if (!version) { const result = await run(['version']); if (result.code !== 0) return false; version = result.stdout; }
    return storageRuntimeSupported(version, platform);
  };
  const change = async fn => {
    await mkdir(home(), { recursive: true, mode: 0o700 });
    const release = await acquireProcessLock(join(home(), 'storage-reservations.lock'), { timeoutMs: 30000 });
    try {
      const rows = await readFile(file(), 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return {}; throw error; });
      if (!rows || Array.isArray(rows) || typeof rows !== 'object' || Object.entries(rows).some(([id, bytes]) => !/^wf-[0-9a-f]{16}$/.test(id) || !Number.isSafeInteger(bytes) || bytes < 0)) throw fail();
      await fn(rows);
      const temporary = file() + '.' + randomUUID();
      const fd = await open(temporary, 'wx', 0o600);
      try { await fd.writeFile(JSON.stringify(rows)); await fd.sync(); } finally { await fd.close(); }
      await rename(temporary, file());
      const directory = await open(home(), 'r'); try { await directory.sync(); } finally { await directory.close(); }
    } finally { await release(); }
  };
  return {
    supported,
    async available(version) {
      if (!await supported(version)) return false;
      const record = await readFile(qualification(), 'utf8').then(JSON.parse).catch(()=>null);
      return record?.runtime === 'linux-sbx-0.49.2' && record?.home === home();
    },
    async recordQualification(qualified = true) {
      await mkdir(home(),{recursive:true,mode:0o700});
      const temporary = qualification() + '.' + randomUUID();
      const fd = await open(temporary,'wx',0o600);
      try { await fd.writeFile(JSON.stringify({runtime:qualified ? 'linux-sbx-0.49.2' : null,home:home()})); await fd.sync(); } finally { await fd.close(); }
      await rename(temporary,qualification());
    },
    reserve: (id, bytes) => change(async rows => {
      storageVolumes(bytes);
      if (Object.hasOwn(rows, id)) throw fail();
      // Reserve provisioning/cache headroom and host working space in addition
      // to every live job's full writable volume capacity. Never count sparse
      // images' current allocation as the job's future maximum.
      if (await freeBytes() < Object.values(rows).reduce((a, b) => a + b, 0) + bytes + 8 * 1024 ** 3) throw fail();
      rows[id] = bytes;
    }),
    release: id => change(rows => { delete rows[id]; }),
    async verify(handle) {
      const result = await run(['exec', handle.sandbox_id, '--', 'lsblk', '-b', '-J', '-o', 'NAME,SIZE,RO,TYPE'],{handle});
      const mounts = await run(['exec', handle.sandbox_id, '--', 'findmnt', '-J', '-o', 'TARGET,FSTYPE,OPTIONS'],{handle});
      try {
        const disks = JSON.parse(result.stdout).blockdevices.filter(d => d.type === 'disk' && d.ro === false && d.size > 0);
        const expected = storageVolumes(handle._resources.storage_mib * MiB, handle._image);
        const sizes = disks.map(d => d.size).sort((a,b) => a-b);
        const visit = rows => rows.every(row => (row.fstype !== 'virtiofs' || row.options.split(',').includes('ro')) && (!row.children || visit(row.children)));
        return result.code === 0 && mounts.code === 0 &&
          sizes.join(',') === [expected.root, expected.docker, ...expected.kit].sort((a,b) => a-b).join(',') && visit(JSON.parse(mounts.stdout).filesystems);
      } catch { return false; }
    },
  };
}
