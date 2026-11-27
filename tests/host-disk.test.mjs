import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostDisk, watchHostDisk, HOST_DISK_FLOOR_BYTES, HOST_DISK_READ_CAP_MS } from '../lib/host-disk.mjs';

const GiB = 1024 ** 3;
// Manual timers and a manual clock: each step() runs the next poll at a chosen time.
function rig(freeAt) {
  let now = 0, pending = null;
  const timers = { setTimeout: (fn) => { pending = fn; return { unref() {} }; }, clearTimeout: () => { pending = null; } };
  const disk = { free: async () => { const value = freeAt(now); if (value instanceof Error) throw value; return { free: value, volumes: [] }; } };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  return { disk, timers, monotonic: () => now,
    async step(ms) { now += ms; const fn = pending; pending = null; fn?.(); await settle(); } };
}

test('createHostDisk counts each filesystem once and reports the smallest free space', async () => {
  const devs = { '/a': 1, '/a/b': 1, '/c': 2 }, free = { '/a': 50, '/c': 5 };
  const disk = createHostDisk({ paths: () => ['/a', '/a/b', '/c'],
    statPath: async p => { if (!(p in devs)) throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { dev: devs[p] }; },
    statfsPath: async p => ({ bavail: free[p], bsize: GiB }) });
  const result = await disk.free();
  assert.equal(result.free, 5 * GiB);
  assert.equal(result.volumes.length, 2);
});

test('createHostDisk measures a path that does not exist yet on its nearest existing parent', async () => {
  const disk = createHostDisk({ paths: () => ['/data/not/yet'],
    statPath: async p => { if (p !== '/data') throw Object.assign(new Error('missing'), { code: 'ENOENT' }); return { dev: 7 }; },
    statfsPath: async p => { assert.equal(p, '/data'); return { bavail: 3, bsize: GiB }; } });
  assert.equal((await disk.free()).free, 3 * GiB);
});

test('the real watcher tolerates a watched directory disappearing between stat and statfs', async () => {
  const r = rig(() => 50 * GiB);
  let failedPaths = 0, parentReads = 0, fired = null;
  const disk = createHostDisk({ paths: () => ['/data/transient'],
    statPath: async p => ({ dev: p === '/data/transient' ? 7 : 1 }),
    statfsPath: async p => {
      if (p === '/data/transient') {
        failedPaths++;
        throw Object.assign(new Error('removed during read'), { code: 'ENOENT' });
      }
      assert.equal(p, '/data'); parentReads++;
      return { bavail: 50, bsize: GiB };
    } });
  const watch = watchHostDisk({ disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic,
    onLow: detail => { fired = detail; } });
  try {
    await r.step(0); await r.step(100); await r.step(100); await r.step(100);
    assert.equal(fired, null, 'readable parent must prevent a false unreadable stop');
    assert.ok(failedPaths >= 3);
    assert.equal(parentReads, failedPaths, 'each disappearance is measured on the existing parent');
  } finally { watch.stop(); }
});

test('statfs ENOTDIR fallback still stops the real watcher when its parent is low', async () => {
  const r = rig(() => GiB);
  let fired = null;
  const disk = createHostDisk({ paths: () => ['/data/transient'],
    statPath: async p => ({ dev: p === '/data/transient' ? 7 : 1 }),
    statfsPath: async p => {
      if (p === '/data/transient') throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
      assert.equal(p, '/data');
      return { bavail: 1, bsize: GiB };
    } });
  const watch = watchHostDisk({ disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic,
    onLow: detail => { fired = detail; } });
  try {
    await r.step(0);
    assert.equal(fired?.reason, 'host_disk_low');
    assert.equal(fired?.path, '/data');
    assert.equal(fired?.free, GiB);
  } finally { watch.stop(); }
});

for (const code of ['EACCES', 'EIO']) test(`statfs ${code} remains fail-closed rather than falling back to a parent`, async () => {
  const calls = [];
  const disk = createHostDisk({ paths: () => ['/private'], statPath: async () => ({ dev: 1 }),
    statfsPath: async p => { calls.push(p); throw Object.assign(new Error(code), { code }); } });
  await assert.rejects(disk.free(), new RegExp(code));
  assert.deepEqual(calls, ['/private']);
});

test('statfs disappearance at the filesystem root fails closed without retrying forever', async () => {
  let calls = 0;
  const disk = createHostDisk({ paths: () => ['/'], statPath: async () => ({ dev: 1 }),
    statfsPath: async () => { calls++; throw Object.assign(new Error('root disappeared'), { code: 'ENOENT' }); } });
  await assert.rejects(disk.free(), /root disappeared/);
  assert.equal(calls, 1);
});

test('the watch fires before a fast writer can cross the floor, using the projected drain', async () => {
  // 1 GiB/s drain from 10 GiB; halt takes 2 s. It must fire while free is still above floor + drain * (halt + poll).
  const r = rig(now => 10 * GiB - now / 1000 * GiB);
  let fired = null;
  watchHostDisk({ disk: r.disk, haltMs: 2000, timers: r.timers, monotonic: r.monotonic, onLow: d => { fired = d; } });
  await r.step(0);
  for (let i = 0; i < 200 && !fired; i++) await r.step(100);
  assert.ok(fired, 'the watch fired');
  assert.ok(fired.free > HOST_DISK_FLOOR_BYTES, 'it fired before free space reached the floor');
  assert.ok(fired.free - 2.1 * GiB < HOST_DISK_FLOOR_BYTES + 0.11 * GiB, 'and not much earlier than needed');
});

test('the watch stays quiet while free space is steady above the floor', async () => {
  const r = rig(() => 9 * GiB);
  let fired = false;
  const watch = watchHostDisk({ disk: r.disk, haltMs: 5000, timers: r.timers, monotonic: r.monotonic, onLow: () => { fired = true; } });
  await r.step(0);
  for (let i = 0; i < 50; i++) await r.step(100);
  assert.equal(fired, false);
  watch.stop();
});

test('three failed reads in a row count as low: the watch fails closed', async () => {
  let reads = 0;
  const r = rig(() => (++reads === 1 ? 9 * GiB : new Error('EIO')));
  let fired = null;
  watchHostDisk({ disk: r.disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic, onLow: d => { fired = d; } });
  await r.step(0); await r.step(100); await r.step(100);
  assert.equal(fired, null, 'two failures are not yet low');
  await r.step(100);
  assert.equal(fired?.error, 'EIO');
});

test('a stopped watch never fires', async () => {
  const r = rig(() => 1 * GiB);
  let fired = false;
  const watch = watchHostDisk({ disk: r.disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic, onLow: () => { fired = true; } });
  watch.stop();
  await r.step(0);
  assert.equal(fired, false);
});

test('a read that never answers counts as failed, so a hung filesystem still fails closed', async () => {
  const r = rig(() => 9 * GiB);
  r.disk.free = () => new Promise(() => {});
  let fired = null;
  watchHostDisk({ disk: r.disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic, onLow: d => { fired = d; } });
  await r.step(0);
  for (let i = 0; i < 6 && !fired; i++) await r.step(500);
  assert.ok(fired, 'the watch fired');
  assert.equal(fired.free, null);
  assert.match(fired.error, /timed out/);
});

test('a late poll projects over the real gap since the last reading', async () => {
  // 0.5 GiB/s from 5 GiB with a 1 s halt: on time, 1.1 s of drain stays above the floor; 4 s late it does not.
  const r = rig(now => 5 * GiB - now / 1000 * GiB / 2);
  let fired = null;
  watchHostDisk({ disk: r.disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic, onLow: d => { fired = d; } });
  await r.step(0);
  await r.step(100);
  assert.equal(fired, null, 'on time, nothing fires');
  await r.step(4000);
  assert.ok(fired, 'a 4 s gap is projected as 4 s of drain');
  assert.ok(fired.free > HOST_DISK_FLOOR_BYTES);
});

test('a process stall that makes the timeout timer fire late is not a disk failure', async () => {
  // Sandpiper 10-31: statfs took 0.03 ms, but a main-thread stall ran the 500 ms timer before the finished read,
  // three times in a row, and a friend's job was stopped as host_disk_unreadable.
  const r = rig(() => 9 * GiB);
  let answer = null;
  r.disk.free = () => new Promise(resolve => { answer = () => resolve({ free: 9 * GiB, volumes: [] }); });
  let fired = null;
  watchHostDisk({ disk: r.disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic, onLow: d => { fired = d; } });
  await r.step(0);
  for (let i = 0; i < 5; i++) {
    await r.step(1500); // the timeout timer runs 1 s late
    answer(); await new Promise(resolve => setImmediate(resolve)); // the read that finished during the stall arrives next
    await r.step(100); // next poll starts a new read
  }
  assert.equal(fired, null);
});

test('a hung read still fails closed when every timer fires late, once the read reaches the cap', async () => {
  const r = rig(() => 9 * GiB);
  let reads = 0, arms = 0;
  r.disk.free = () => { reads++; return new Promise(() => {}); };
  const setTimer = r.timers.setTimeout;
  r.timers.setTimeout = (fn, ms) => { if (ms === 500) arms++; return setTimer(fn, ms); };
  let fired = null;
  watchHostDisk({ disk: r.disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic, onLow: d => { fired = d; } });
  for (let i = 0; i < 40 && !fired; i++) await r.step(1500); // the first read starts at once, so no step(0)
  assert.ok(fired, 'the watch fired');
  assert.match(fired.error, /timed out/);
  assert.equal(reads, 3);
  assert.equal(arms, 3 * Math.ceil(HOST_DISK_READ_CAP_MS / 1500)); // each read re-arms until it has taken the cap
});

test('after one stall, a hung read times out on the next on-time timer', async () => {
  const r = rig(() => 9 * GiB);
  let reads = 0;
  r.disk.free = () => { reads++; return new Promise(() => {}); };
  let fired = null;
  watchHostDisk({ disk: r.disk, haltMs: 1000, timers: r.timers, monotonic: r.monotonic, onLow: d => { fired = d; } });
  for (let i = 0; i < 3; i++) {
    await r.step(1500); // late: re-arm
    await r.step(500); // on time: this read fails
    if (i < 2) await r.step(100); // next poll
  }
  assert.equal(reads, 3);
  assert.match(fired?.error ?? '', /timed out/);
});

test('the real reader survives real 700 ms event-loop stalls', async () => {
  const real = createHostDisk({ paths: () => [process.cwd()] });
  let reads = 0, fired = null;
  const disk = { free() { reads++; const p = real.free(); setImmediate(() => { const t = Date.now(); while (Date.now() - t < 700); }); return p; } };
  const watch = watchHostDisk({ disk, haltMs: 0, floor: 1, onLow: d => { fired = d; } }); // timeouts only, not this host's free space
  while (reads < 5 && !fired) await new Promise(resolve => setTimeout(resolve, 50));
  watch.stop();
  assert.equal(fired, null, `fired after ${reads} reads: ${fired?.error}`);
});

test('a read that needs several stalled event-loop turns is not a disk failure', async () => {
  // Sandpiper 10-31 on .33: the app's main thread was busy about half the time, and a read takes one
  // turn per stat. Each turn here stalls 300 ms; a read takes six turns, far past a 100 ms timeout.
  const real = createHostDisk({ paths: () => [process.cwd()] });
  const stall = () => new Promise(resolve => setImmediate(() => { const t = Date.now(); while (Date.now() - t < 300); resolve(); }));
  let reads = 0, fired = null;
  const disk = { async free() { reads++; for (let i = 0; i < 5; i++) await stall(); return real.free(); } };
  const watch = watchHostDisk({ disk, haltMs: 0, floor: 1, readTimeoutMs: 100, onLow: d => { fired = d; } });
  while (reads < 4 && !fired) await new Promise(resolve => setTimeout(resolve, 50));
  watch.stop();
  assert.equal(fired, null, `fired after ${reads} reads: ${fired?.error}`);
});
