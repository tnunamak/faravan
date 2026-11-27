import { stat, statfs } from 'node:fs/promises';
import path from 'node:path';

// Bounded guarantee: 8 GiB headroom, a 2 GiB floor, a 5 s halt, and detection
// within two 100 ms polls keep free space above the floor for sustained writers
// up to 1.0 GB/s. This assumes subsequent polls also arrive within 100 ms and
// every writer halts within 5 s; late reads/scheduling are not a latency bound.
// Faster writers are not covered until per-job disk containment exists.
// Memory filesystems have independent runtime floors.
export const HOST_DISK_HEADROOM_BYTES = 8 * 1024 ** 3;
export const HOST_DISK_FLOOR_BYTES = 2 * 1024 ** 3;
export const HOST_DISK_POLL_MS = 100;
export const HOST_DISK_READ_TIMEOUT_MS = 500;
export const HOST_DISK_STALL_SLACK_MS = 100;
export const HOST_DISK_READ_CAP_MS = 10000;
export const HOST_DISK_LOW = 'This computer is low on disk space. Faravan lends only with at least 8 GiB free.';
export const HOST_DISK_STOPPED = 'Stopped by the lender: this computer ran low on disk space.';
export const HOST_DISK_UNREADABLE = 'Could not read free disk space';

/** Validate even injected adapters at admission, preparation and every runtime read. */
export function validateHostDiskReading(reading) {
  for (const volume of [reading, ...(reading?.volumes ?? [])]) {
    if (!Number.isFinite(volume?.free) || volume.free < 0)
      throw Object.assign(new Error('invalid free disk space'), { path: volume?.path });
  }
  return reading;
}

export function hostDiskLow(reading) {
  const volume = reading?.volumes?.filter(v => !v.memory).sort((a, b) => a.free - b.free)[0] ?? reading;
  return volume?.path ? `${HOST_DISK_LOW} ${volume.path} has ${(volume.free / 1024 ** 3).toFixed(1)} GiB free.` : HOST_DISK_LOW;
}
export function hostDiskUnreadable(error, at = error?.path) {
  return `${HOST_DISK_UNREADABLE} at ${at ?? 'the watched filesystem'}: ${error?.message ?? error}. Faravan will not lend until it can read this filesystem.`;
}
export function hostDiskStop(detail) {
  if (detail?.reason === 'host_disk_unreadable') return hostDiskUnreadable(detail.error, detail.path);
  return detail?.path ? `${HOST_DISK_STOPPED} ${detail.path} has ${(detail.free / 1024 ** 3).toFixed(1)} GiB free.` : HOST_DISK_STOPPED;
}

/** Find the existing ancestor without losing the path when a read fails. */
async function existing(dir, statPath) {
  for (let at = path.resolve(dir); ; at = path.dirname(at)) {
    try { return { at, info: await statPath(at) }; } catch (error) {
      if ((error.code !== 'ENOENT' && error.code !== 'ENOTDIR') || path.dirname(at) === at)
        throw Object.assign(new Error(error.message, { cause: error }), { path: at });
    }
  }
}

/** Distinct filesystems; free is the minimum disk headroom, never a RAM volume's capacity. */
export function createHostDisk({ paths, statfsPath = statfs, statPath = stat }) {
  return {
    async free() {
      const volumes = new Map();
      for (const dir of paths()) {
        for (let candidate = dir; ;) {
          const { at, info } = await existing(candidate, statPath);
          if (volumes.has(info.dev)) break;
          try {
            const fs = await statfsPath(at);
            const type = Number(fs.type) >>> 0;
            const memory = type === 0x01021994 || type === 0x858458f6;
            const bsize = Number(fs.bsize), bavail = Number(fs.bavail);
            if (!Number.isFinite(bsize) || bsize <= 0 || !Number.isFinite(bavail) || bavail < 0)
              throw new Error('invalid filesystem capacity');
            const free = bavail * bsize;
            const total = Number(fs.blocks) * bsize;
            if (!Number.isFinite(free) || (memory && (!Number.isFinite(total) || total <= 0)))
              throw new Error('invalid filesystem capacity');
            volumes.set(info.dev, { path: at, free, total, memory });
          } catch (error) {
            // The directory can disappear after stat succeeds. Use the same
            // nearest-existing-parent policy as existing(), with bounded ascent.
            if ((error.code === 'ENOENT' || error.code === 'ENOTDIR') && path.dirname(at) !== at) {
              candidate = path.dirname(at);
              continue;
            }
            throw Object.assign(new Error(error.message, { cause: error }), { path: at });
          }
          break;
        }
      }
      if (!volumes.size) throw new Error('no filesystem to watch');
      const all = [...volumes.values()];
      const disks = all.filter(v => !v.memory);
      if (!disks.length) throw new Error('no disk-backed volume was found');
      return { free: Math.min(...disks.map(v => v.free)), volumes: all };
    },
  };
}

/**
 * Stop once when a filesystem may cross its floor before every writer halts.
 * Price the larger of the trailing-second drain and the last two poll gaps,
 * never a single-poll spike. Late polls retain their actual gap. Each volume has its
 * own history: changes in which volume is smallest cannot invent a drain.
 * Three failed/timed-out reads fail closed with an unreadable reason, not low space.
 * A read times out only on a timer that fires on time. A late timer means this process stalled:
 * a read takes several event-loop turns (one per stat), and a finished read waits behind the
 * timer. So a late timer re-arms, until the read has taken HOST_DISK_READ_CAP_MS. The verdict
 * waits for setImmediate, which runs after Node delivers finished reads. With a responsive
 * process a hung read fails after 500 ms; if the process stalls all the time, after 10 s.
 */
export function watchHostDisk({ disk, onLow, haltMs, floor = HOST_DISK_FLOOR_BYTES, intervalMs = HOST_DISK_POLL_MS,
  readTimeoutMs = HOST_DISK_READ_TIMEOUT_MS, monotonic = () => performance.now(), timers = { setTimeout, clearTimeout } }) {
  const histories = new Map();
  let timer = null, stopped = false, fired = false, errors = 0;
  const fire = detail => { if (fired || stopped) return; fired = true; onLow(detail); };
  const tick = async () => {
    timer = null;
    if (stopped || fired) return;
    let late;
    try {
      const reading = validateHostDiskReading(await Promise.race([disk.free(), new Promise((_, reject) => {
        const started = monotonic();
        let due = started + readTimeoutMs;
        const expire = () => {
          const now = monotonic();
          if (now - due > HOST_DISK_STALL_SLACK_MS && now - started < HOST_DISK_READ_CAP_MS) {
            due = now + readTimeoutMs; late = timers.setTimeout(expire, readTimeoutMs); late?.unref?.(); return;
          }
          setImmediate(() => reject(new Error('disk read timed out')));
        };
        late = timers.setTimeout(expire, readTimeoutMs); late?.unref?.();
      })]));
      errors = 0;
      const at = monotonic();
      const volumes = reading.volumes?.length ? reading.volumes : [reading];
      const seen = new Set();
      for (const volume of volumes) {
        const key = volume.path ?? 'default';
        seen.add(key);
        const samples = histories.get(key) ?? [];
        histories.set(key, samples);
        const free = volume.free;
        const volumeFloor = volume.memory ? Math.min(floor, volume.total * 0.1) : floor;
        const gap = samples.length ? at - samples.at(-1).at : intervalMs;
        samples.push({ at, free });
        while (samples.length > 3 && at - samples[1].at > 1000) samples.shift();
        const elapsed = (at - samples[0].at) / 1000;
        // Fully price a recent burst only when BOTH gaps drain. A blip followed
        // or preceded by a flat gap still contributes to the trailing rate.
        const recent = samples.length >= 3 ? samples.at(-3) : null;
        const recentSeconds = recent ? (at - recent.at) / 1000 : 0;
        const bothDrain = recent && recent.free > samples.at(-2).free && samples.at(-2).free > free;
        const rate = Math.max(0, (samples[0].free - free) / Math.max(elapsed, 1),
          bothDrain && recentSeconds > 0 ? (recent.free - free) / recentSeconds : 0);
        const projected = free - rate * (haltMs + Math.max(intervalMs, gap)) / 1000;
        // Equality must fire too: waiting one more poll would end AT the floor.
        if (free < volumeFloor || projected <= volumeFloor)
          return fire({ reason: 'host_disk_low', path: volume.path, free, rate, projected, floor: volumeFloor });
      }
      for (const key of histories.keys()) if (!seen.has(key)) histories.delete(key);
    } catch (error) {
      if (++errors >= 3) return fire({ reason: 'host_disk_unreadable', path: error.path,
        free: null, rate: null, projected: null, error: error.message });
    } finally { timers.clearTimeout(late); }
    if (!stopped && !fired) { timer = timers.setTimeout(tick, intervalMs); timer?.unref?.(); }
  };
  tick();
  return { stop() { stopped = true; if (timer) timers.clearTimeout(timer); }, get fired() { return fired; } };
}
