#!/usr/bin/env node
// Proves the host disk watch stops a full-speed writer before free space reaches zero, without filling
// the disk: the floor is raised to just below the current free space, and the overshoot below that
// floor is what a real fill would see below the real floor. The writer keeps running for --halt-ms after
// the trigger, standing in for the time the real stop takes to halt the sandbox.
// With --floor-gib, DIR should be a small filesystem that can really fill (a fuse2fs-mounted ext4
// image, for example): the floor is used as given and zero is a real ENOSPC.
// Host safety: the raised-floor mode writes at most about --budget-gib, and each run deletes its file.
//   node scripts/host-disk-overshoot.mjs --dir DIR [--budget-gib 3 | --floor-gib 0.5] [--halt-ms 1000] [--runs 3]
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createHostDisk, watchHostDisk, HOST_DISK_FLOOR_BYTES } from '../lib/host-disk.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : fallback; };
const dir = arg('dir'); if (!dir) { console.error('--dir is required'); process.exit(2); }
const realFloor = arg('floor-gib') === undefined ? null : Number(arg('floor-gib')) * 1024 ** 3;
const budget = Number(arg('budget-gib', '3')) * 1024 ** 3, haltMs = Number(arg('halt-ms', '1000')), runs = Number(arg('runs', '3'));
const GiB = n => (n / 1024 ** 3).toFixed(2);
// The writer: 4 MiB unthrottled writes, the fastest way to drain free space through the page cache.
// It exits 28 on ENOSPC: the filesystem really reached zero.
const WRITER = `const fs=require('fs');const fd=fs.openSync(process.argv[1],'w',0o600);const b=Buffer.alloc(4<<20);try{for(;;)fs.writeSync(fd,b);}catch(e){process.exit(e.code==='ENOSPC'?28:1);}`;

await mkdir(dir, { recursive: true });
const hostDisk = createHostDisk({ paths: () => [dir] });
// This experiment measures one target volume, including tmpfs, not admission headroom.
// Present the measured bytes alone so the synthetic raised floor remains the experiment's
// floor rather than being capped by the production memory-volume floor.
const disk = { async free() {
  return { free: Math.min(...(await hostDisk.free()).volumes.map(volume => volume.free)) };
} };
const results = [];
for (let run = 1; run <= runs; run++) {
  const file = path.join(dir, `overshoot-${process.pid}-${run}.bin`);
  const start = (await disk.free()).free;
  // A real floor of 2 GiB sits `budget` below the starting free space.
  const floor = realFloor ?? start - budget, zero = realFloor === null ? floor - HOST_DISK_FLOOR_BYTES : 0;
  const writer = spawn(process.execPath, ['-e', WRITER, file], { stdio: 'ignore' });
  let exitCode = null; const exited = new Promise(resolve => writer.once('exit', code => { exitCode = code; resolve(); }));
  const t0 = performance.now();
  const trigger = await new Promise(resolve => {
    const watch = watchHostDisk({ disk, haltMs, floor, onLow: detail => { watch.stop(); resolve({ ...detail, at: performance.now() - t0 }); } });
  });
  await new Promise(resolve => setTimeout(resolve, haltMs));
  writer.kill('SIGKILL');
  await exited;
  const after = (await disk.free()).free;
  results.push({ run, written_gib: GiB(start - after), trigger_ms: Math.round(trigger.at), peak_rate_gib_s: GiB(trigger.rate),
    overshoot_below_floor_gib: GiB(Math.max(0, floor - after)), reached_zero: after <= zero || exitCode === 28 });
  await rm(file, { force: true });
}
console.log(JSON.stringify({ dir, halt_ms: haltMs, floor_gib: GiB(realFloor ?? HOST_DISK_FLOOR_BYTES), mode: realFloor === null ? 'raised floor' : 'real fill', results }, null, 1));
process.exit(results.some(r => r.reached_zero) ? 1 : 0);
