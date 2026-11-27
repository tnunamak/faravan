import { execFile } from 'node:child_process';
import { HOST_DISK_HEADROOM_BYTES, validateHostDiskReading } from './host-disk.mjs';

// Disk-space observations, recovery margins and read-only Docker reclaim suggestions.
// This module never deletes anything.
const GiB = 1024 ** 3;
export const DISK_WAITS_FOR = 'host_disk';
/** Free space must pass the headroom by this much before waiting work runs again. */
export const DISK_RESUME_MARGIN_BYTES = GiB;
export const DOCKER_DF_COMMAND = 'docker system df -v';

// Output of sbx or Docker that means the disk is full. Checked before every other cause.
export const DISK_FULL_PATTERN = /no space left on device|\bENOSPC\b|not enough (?:disk )?space|insufficient (?:disk )?space|disk (?:is )?full|out of (?:disk )?space/i;

const tenths = bytes => (Math.floor(bytes / GiB * 10) / 10).toFixed(1);
const whole = bytes => String(Math.round(bytes / GiB * 10) / 10);

/** The one set of words for a disk wait. `wait` is a value from diskWaitFrom*(). The amount to free includes the resume
 * margin, so freeing it is enough for waiting work to continue. */
export function diskWaitCopy(wait) {
  const volume = wait.volume || 'this computer’s disk';
  if (wait.kind === 'unreadable')
    return `Waiting for disk space: Faravan could not read the free space on ${volume}. It tries again by itself.`;
  if (wait.kind === 'docker_full')
    return `Waiting for disk space: Docker Sandboxes ran out of space while preparing a job${Number.isFinite(wait.free_bytes) ? `, though ${volume} has ${tenths(wait.free_bytes)} GiB free` : ''}. Free some space Docker uses, then check readiness again.`;
  const toFree = short => Math.max(1, Math.ceil((short + DISK_RESUME_MARGIN_BYTES) / GiB));
  const short = wait.volumes ?? [];
  if (short.length > 1) {
    const each = short.map(v => ({ name: v.volume || v.volume_path || 'a disk', free: tenths(v.free_bytes), amount: toFree(v.short_bytes) }));
    return `Waiting for disk space: Faravan needs ${whole(wait.needed_bytes)} GiB free on each disk it uses. ${listed(each.map(v => `${v.name} has ${v.free} GiB`))}. Free about ${listed(each.map(v => `${v.amount} GiB on ${v.name}`))}.`;
  }
  return `Waiting for disk space: Faravan needs ${whole(wait.needed_bytes)} GiB free on ${volume} and it has ${tenths(wait.free_bytes)} GiB. Free about ${toFree(wait.short_bytes)} GiB.`;
}
const listed = items => items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items.at(-1)}` : items[0];

const withCopy = wait => ({ ...wait, copy: diskWaitCopy(wait) });

const diskVolumes = reading => (reading.volumes?.length ? reading.volumes : [reading]).filter(volume => volume && !volume.memory);
const shortOf = (volume, headroom) => ({ volume: volume.path ?? null, volume_path: volume.path ?? null, free_bytes: volume.free,
  short_bytes: Math.max(0, headroom - volume.free) });

/** null when the reading has enough room; else the low-disk wait. `volumes` lists every disk-backed volume below the
 * headroom, smallest first; the top-level fields describe the smallest. */
export function diskWaitFromReading(reading, { headroom = HOST_DISK_HEADROOM_BYTES } = {}) {
  if (!(reading.free < headroom)) return null;
  const sorted = [...diskVolumes(reading)].sort((a, b) => a.free - b.free);
  const short = sorted.filter(volume => volume.free < headroom);
  const smallest = sorted[0] ?? reading;
  return withCopy({ kind: 'low', ...shortOf(smallest, headroom), needed_bytes: headroom,
    volumes: (short.length ? short : [smallest]).map(volume => shortOf(volume, headroom)) });
}
export function diskWaitUnreadable(error, { headroom = HOST_DISK_HEADROOM_BYTES } = {}) {
  const path = error?.path ?? null;
  return withCopy({ kind: 'unreadable', volume: path, volume_path: path,
    free_bytes: null, needed_bytes: headroom, short_bytes: null });
}
/** The disk was full inside Docker although the host reading is fine (or was not asked). */
export function diskWaitDockerFull(reading, { headroom = HOST_DISK_HEADROOM_BYTES } = {}) {
  const volumes = (reading.volumes?.length ? reading.volumes : [reading]).filter(volume => volume && !volume.memory);
  const smallest = [...volumes].sort((a, b) => a.free - b.free)[0] ?? reading;
  return withCopy({ kind: 'docker_full', volume: smallest.path ?? null, volume_path: smallest.path ?? null,
    free_bytes: smallest.free, needed_bytes: headroom, short_bytes: 0 });
}

/** True when every disk is at the headroom and every disk that was short has passed the headroom plus the margin (and,
 * for a full Docker disk, free space has grown since the wait began). Volumes are matched by path; without a list of
 * volumes the reading's own free space stands for each. */
export function diskRecovered(wait, reading, { margin = DISK_RESUME_MARGIN_BYTES } = {}) {
  if (!Number.isFinite(reading?.free)) return false;
  if (wait.kind !== 'low') {
    if (reading.free < wait.needed_bytes + margin) return false;
    return wait.kind !== 'docker_full' || reading.free >= wait.free_bytes + margin;
  }
  const disks = reading.volumes?.length ? diskVolumes(reading) : [];
  if (!disks.every(volume => volume.free >= wait.needed_bytes) || reading.free < wait.needed_bytes) return false;
  const freeOn = path => disks.find(volume => path != null && volume.path === path)?.free ?? reading.free;
  return (wait.volumes ?? [wait]).every(short => freeOn(short.volume_path) >= wait.needed_bytes + margin);
}

// ---- Docker: what could be freed (read only) ------------------------------------------------------------------

const UNITS = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };
export function parseDockerSize(text) {
  const match = /^\s*([\d.]+)\s*([kKMGT]?B)\s*$/.exec(String(text ?? ''));
  const unit = match && UNITS[match[2].toUpperCase()];
  const bytes = match && unit ? Number(match[1]) * unit : NaN;
  return Number.isFinite(bytes) ? Math.round(bytes) : null;
}
const VOLUME_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const IMAGE_ID = /^(?:sha256:)?[a-f0-9]{12,64}$/i;

function tableSection(text, heading) {
  const start = text.search(new RegExp('^' + heading + '.*$', 'mi'));
  if (start < 0) return [];
  const lines = text.slice(start).split(/\r?\n/).slice(1);
  const rows = [];
  for (const line of lines.slice(lines.findIndex(l => l.trim()))) {
    if (!line.trim()) break;
    rows.push(line.trim().split(/\s{2,}/));
  }
  return rows.slice(1); // the header row
}

/** Rows of `docker system df -v`, from its JSON form or its table. null when the text is neither. */
export function parseDockerSystemDf(stdout) {
  const text = String(stdout ?? '').trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    if (json && typeof json === 'object' && !Array.isArray(json))
      return { images: Array.isArray(json.Images) ? json.Images.map(row => ({ id: row.ID ?? row.ImageID, repository: row.Repository, tag: row.Tag,
          size: row.UniqueSize ?? row.Size, containers: Number(row.Containers) })) : [],
        volumes: Array.isArray(json.Volumes) ? json.Volumes.map(row => ({ name: row.Name, links: Number(row.Links), size: row.Size })) : [] };
  } catch { /* the table form follows */ }
  if (!/space usage/i.test(text)) return null;
  return {
    images: tableSection(text, 'Images space usage').filter(r => r.length >= 8)
      .map(r => ({ repository: r[0], tag: r[1], id: r[2], size: r[6], containers: Number(r[7]) })),
    volumes: tableSection(text, 'Local Volumes space usage').filter(r => r.length >= 3)
      .map(r => ({ name: r[0], links: Number(r[1]), size: r[2] })),
  };
}

/** The largest unused volumes and images, with the command that would remove each. Never run by Faravan. */
export function reclaimableDocker(parsed, { limit = 3 } = {}) {
  const items = [];
  for (const volume of parsed?.volumes ?? []) {
    const bytes = parseDockerSize(volume.size);
    if (volume.links === 0 && bytes !== null && VOLUME_NAME.test(String(volume.name)))
      items.push({ kind: 'volume', name: volume.name, bytes, size: String(volume.size), command: `docker volume rm ${volume.name}` });
  }
  for (const image of parsed?.images ?? []) {
    const bytes = parseDockerSize(image.size), id = String(image.id ?? '');
    if (image.containers === 0 && bytes !== null && IMAGE_ID.test(id)) {
      const tagged = image.repository && image.repository !== '<none>';
      items.push({ kind: 'image', name: tagged ? `${image.repository}:${image.tag && image.tag !== '<none>' ? image.tag : 'latest'}` : `Unnamed image ${id.replace(/^sha256:/, '').slice(0, 12)}`,
        bytes, size: String(image.size), command: `docker image rm ${id}` });
    }
  }
  return items.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

function runDockerCli(args) {
  return new Promise(resolve => {
    try {
      execFile('docker', args, { timeout: 10_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) =>
        resolve(error ? { code: typeof error.code === 'number' ? error.code : 1, stdout: stdout || '', stderr: stderr || '', missing: error.code === 'ENOENT' } : { code: 0, stdout, stderr }));
    } catch { resolve({ code: 1, stdout: '', stderr: '', missing: true }); }
  });
}

/** {command, items} when Docker answered; null when the Docker CLI is missing or does not answer. */
export async function listDockerReclaimable({ run = runDockerCli } = {}) {
  try {
    const result = await run(['system', 'df', '-v', '--format', 'json']);
    let parsed = result?.code === 0 ? parseDockerSystemDf(result.stdout) : null;
    if (!parsed && !result?.missing) {
      const table = await run(['system', 'df', '-v']);
      parsed = table?.code === 0 ? parseDockerSystemDf(table.stdout) : null;
    }
    return parsed ? { command: DOCKER_DF_COMMAND, items: reclaimableDocker(parsed) } : null;
  } catch { return null; }
}

/**
 * @param hostDisk       the existing host-disk reader (or a function that returns it, or null)
 * @param listReclaimable async () => {docker, faravan}; read only
 */
export function createDiskWait({ hostDisk, headroom = HOST_DISK_HEADROOM_BYTES, margin = DISK_RESUME_MARGIN_BYTES, volumeName = async path => path,
  listReclaimable = async () => ({ docker: null, faravan: [] }) } = {}) {
  let cached = null;
  const names = new Map();
  const disk = () => (typeof hostDisk === 'function' ? hostDisk() : hostDisk) ?? null;
  const options = () => ({ headroom });
  /** The volume's own name (for example "Macintosh HD"), looked up once per path. */
  async function nameOf(path) {
    if (!names.has(path)) names.set(path, await Promise.resolve(volumeName(path)).catch(() => null) ?? path);
    return names.get(path);
  }
  async function named(wait) {
    if (!wait?.volume_path) return wait;
    const volumes = wait.volumes && await Promise.all(wait.volumes.map(async v => v.volume_path ? { ...v, volume: await nameOf(v.volume_path) } : v));
    return withCopy({ ...wait, volume: await nameOf(wait.volume_path), ...(volumes ? { volumes } : {}) });
  }
  /** {reading, wait}: reading is null when the disk cannot be read (wait says so) or no reader exists (wait is null). */
  async function read() {
    const reader = disk();
    if (!reader) return { reading: null, wait: null };
    try {
      const reading = validateHostDiskReading(await reader.free());
      return { reading, wait: await named(diskWaitFromReading(reading, options())) };
    } catch (error) { return { reading: null, wait: await named(diskWaitUnreadable(error, options())) }; }
  }
  return {
    get cached() { return cached; },
    /** The wait to start the test with, or null when there is room. Keeps the last answer for the synchronous status reads. */
    async check() { const { wait } = await read(); cached = wait; return wait; },
    /** The wait for an out-of-space fault in the middle of a test: the host's own shortage if there is one, else a full Docker disk. */
    async fault() {
      const { reading, wait } = await read();
      cached = wait ?? (reading ? await named(diskWaitDockerFull(reading, options())) : null);
      return cached ?? withCopy({ kind: 'docker_full', volume: null, volume_path: null, free_bytes: null, needed_bytes: headroom, short_bytes: 0 });
    },
    async recovered(wait) {
      const { reading, wait: now } = await read();
      cached = now;
      return reading !== null && diskRecovered(wait, reading, { margin });
    },
    /** The wait plus what a person could free. Read only. */
    async describe(wait) {
      try {
        const found = await listReclaimable();
        return { ...wait, reclaim: { docker: found?.docker ?? null, faravan: found?.faravan ?? [] } };
      } catch { return { ...wait, reclaim: { docker: null, faravan: [] } }; }
    },
    clear() { cached = null; },
  };
}

/** Name of the macOS startup volume (for example "Macintosh HD"), else the path itself. */
export async function volumeNameFor(path, { platform = process.platform, run = (command, args) => new Promise(resolve => {
  try { execFile(command, args, { timeout: 3000 }, (error, stdout) => resolve(error ? null : stdout)); } catch { resolve(null); } }) } = {}) {
  if (platform !== 'darwin' || typeof path !== 'string') return path ?? null;
  const mounted = /^\/Volumes\/([^/]+)/.exec(path);
  if (mounted) return mounted[1];
  const out = await run('diskutil', ['info', '/']);
  return /^\s*Volume Name:\s*(.+)$/m.exec(String(out ?? ''))?.[1].trim() || path;
}
