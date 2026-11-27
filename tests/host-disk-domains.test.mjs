import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostDisk, watchHostDisk, HOST_DISK_HEADROOM_BYTES, HOST_DISK_FLOOR_BYTES, hostDiskLow, hostDiskUnreadable } from '../lib/host-disk.mjs';
import * as hostDiskModule from '../lib/host-disk.mjs';
const { validateHostDiskReading } = hostDiskModule;
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { lendingBlockers } from '../lib/v1/blockers.mjs';
import { createDeadlineRecoveryGate } from '../lib/v1/deadline-recovery-gate.mjs';
// The app's real lifecycle gate over a backend that reports no recovery hold.
const recoveryGate = () => createDeadlineRecoveryGate({ backend: {}, signal: new AbortController().signal });
import * as backendModule from '../lib/docker-backend.mjs';
const { DockerSbxBackend } = backendModule;
const hostDiskPaths = options => backendModule.hostDiskPaths(options);

const GiB = 1024 ** 3;
const TMPFS = 0x01021994, RAMFS = 0x858458f6;
function diskWith(rows) {
  return createHostDisk({
    paths: () => Object.keys(rows),
    statPath: async p => ({ dev: p }),
    statfsPath: async p => {
      const row = typeof rows[p] === 'function' ? rows[p]() : rows[p];
      if (row instanceof Error) throw row;
      return { type: 0xef53, blocks: 100 * GiB, bsize: 1, ...row };
    },
  });
}
const readiness = disk => DockerSbxBackend.prototype._hostDiskCheck.call({ hostDisk: disk });
const settle = () => new Promise(resolve => setImmediate(resolve));
function rig(read) {
  let now = 0;
  const pending = new Set();
  const timers = {
    setTimeout(fn, ms) { const id = { fn, at: now + ms, unref() {} }; pending.add(id); return id; },
    clearTimeout(id) { pending.delete(id); },
  };
  return {
    timers, monotonic: () => now,
    disk: { free: () => read(now) },
    async step(ms = 100) {
      now += ms;
      for (const id of [...pending].filter(id => id.at <= now)) { pending.delete(id); id.fn(); }
      await settle();
    },
  };
}
async function watching(r, options = {}) {
  let detail = null;
  const watch = watchHostDisk({ disk: r.disk, timers: r.timers, monotonic: r.monotonic,
    haltMs: 5000, onLow: value => { detail = value; }, ...options });
  await settle();
  return { watch, get detail() { return detail; } };
}

test('tmpfs at 1.5 GiB does not veto the real disk with 47 GiB admission headroom', async () => {
  const disk = diskWith({ '/ram': { type: TMPFS, blocks: 16 * GiB, bavail: 1.5 * GiB },
    '/data': { bavail: 47 * GiB } });
  const reading = await disk.free();
  assert.equal(reading.free, 47 * GiB);
  assert.equal(reading.volumes.length, 2, 'memory remains in runtime monitoring');
  assert.equal(reading.volumes.find(v => v.path === '/ram').memory, true);
  assert.equal((await readiness(disk)).ok, true);
});

test('ramfs (including a signed statfs type) is also a memory volume', async () => {
  for (const type of [RAMFS, RAMFS | 0]) {
    const disk = diskWith({ '/ram': { type, blocks: GiB, bavail: GiB / 2 }, '/data': { bavail: 47 * GiB } });
    assert.equal((await disk.free()).free, 47 * GiB);
    assert.equal((await readiness(disk)).ok, true);
  }
});

test('a real disk at 6 GiB refuses lending and identifies its path and free GiB', async () => {
  const check = await readiness(diskWith({ '/data': { bavail: 6 * GiB }, '/other': { bavail: 47 * GiB } }));
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'host_disk_low');
  assert.match(check.detail, /\/data/);
  assert.match(check.detail, /6\.0 GiB/);
});

test('at 8 GiB, one 250 MB blip after flat history and a flat gap never fires', async () => {
  const r = rig(async now => ({ free: 8 * GiB - (now >= 1100 ? 250e6 : 0) }));
  const w = await watching(r);
  try {
    for (let i = 0; i < 30; i++) { await r.step(); assert.equal(w.detail, null); }
  } finally { w.watch.stop(); }
});

test('sustained 2.5 GB/s drain fires before reaching the disk floor', async () => {
  const r = rig(async now => ({ free: 13 * GiB - now / 1000 * 2.5e9 }));
  const w = await watching(r);
  try {
    for (let i = 0; i < 100 && !w.detail; i++) await r.step();
    assert.ok(w.detail);
    assert.equal(w.detail.reason, 'host_disk_low');
    assert.ok(w.detail.free > HOST_DISK_FLOOR_BYTES);
    assert.equal(w.detail.rate, 2.5e9);
  } finally { w.watch.stop(); }
});

test('at 8 GiB, one startup 250 MB blip followed by a flat gap never fires', async () => {
  const r = rig(async now => ({ free: 8 * GiB - (now >= 100 ? 250e6 : 0) }));
  const w = await watching(r);
  try {
    for (let i = 0; i < 30; i++) { await r.step(); assert.equal(w.detail, null); }
  } finally { w.watch.stop(); }
});

test('a 2.5 GB/s writer at 8 GiB fires on its second poll, not a full-halt guarantee', async () => {
  const rate = 2.5e9, haltMs = 5000;
  const r = rig(async now => ({ free: 8 * GiB - now / 1000 * rate }));
  const w = await watching(r, { haltMs });
  try {
    await r.step(); assert.equal(w.detail, null);
    await r.step();
    assert.equal(w.detail?.reason, 'host_disk_low');
    assert.equal(w.detail.rate, rate);
    assert.ok(w.detail.free > HOST_DISK_FLOOR_BYTES);
    const afterHalt = w.detail.free - rate * haltMs / 1000;
    assert.ok(afterHalt < HOST_DISK_FLOOR_BYTES, '8 GiB cannot cover this writer for the full halt');
  } finally { w.watch.stop(); }
});

test('a burst accelerating from idle is fully priced after two poll gaps', async () => {
  const r = rig(async now => ({ free: 13 * GiB - Math.max(0, now - 2000) / 1000 * 2.5e9 }));
  const w = await watching(r);
  try {
    for (let i = 0; i < 21; i++) { await r.step(); assert.equal(w.detail, null); }
    await r.step();
    assert.equal(w.detail?.rate, 2.5e9);
    assert.equal(w.detail?.reason, 'host_disk_low');
  } finally { w.watch.stop(); }
});

test('memory volumes retain their own min(2 GiB, 10% total) runtime floor', async () => {
  for (const [total, floor] of [[GiB, GiB * 0.1], [32 * GiB, 2 * GiB]]) {
    let free = floor + GiB / 10;
    const disk = diskWith({ '/ram': () => ({ type: TMPFS, blocks: total, bavail: free }),
      '/data': { bavail: 47 * GiB } });
    const r = rig(() => disk.free()), w = await watching(r, { haltMs: 0 });
    try {
      assert.equal(w.detail, null);
      free = floor - 1;
      await r.step();
      assert.equal(w.detail?.path, '/ram');
      assert.equal(w.detail?.floor, floor);
    } finally { w.watch.stop(); }
  }
});

test('a statfs read error refuses lending as unreadable, preserving path and error', async () => {
  const disk = diskWith({ '/data': new Error('EIO synthetic read failure') });
  const check = await readiness(disk);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'host_disk_unreadable');
  assert.match(check.detail, /Could not read free disk space.*\/data.*EIO/);
  assert.doesNotMatch(check.detail, /low on disk space/);
});

test('stat errors also preserve the failing path', async () => {
  const disk = createHostDisk({ paths: () => ['/private/data'],
    statPath: async () => { throw Object.assign(new Error('EACCES denied'), { code: 'EACCES' }); } });
  const check = await readiness(disk);
  assert.equal(check.reason, 'host_disk_unreadable');
  assert.match(check.detail, /\/private\/data.*EACCES/);
});

test('three runtime read failures fail closed as unreadable rather than low', async () => {
  const disk = diskWith({ '/data': new Error('EIO runtime failure') });
  const r = rig(() => disk.free()), w = await watching(r);
  try {
    await r.step(); assert.equal(w.detail, null);
    await r.step();
    assert.equal(w.detail?.reason, 'host_disk_unreadable');
    assert.equal(w.detail?.path, '/data');
    assert.match(w.detail?.error, /EIO/);
  } finally { w.watch.stop(); }
});

test('all watched paths on memory filesystems refuse admission as unreadable', async () => {
  const disk = diskWith({ '/ram': { type: TMPFS, blocks: 100 * GiB, bavail: 47 * GiB },
    '/ramfs': { type: RAMFS, blocks: 100 * GiB, bavail: 47 * GiB } });
  const check = await readiness(disk);
  assert.equal(check.ok, false);
  assert.equal(check.reason, 'host_disk_unreadable');
  assert.match(check.detail, /no disk-backed volume was found/);
  assert.doesNotMatch(check.detail, /low on disk space/);
});

// Exercise the app's actual closure bodies with inert dependencies: no server,
// credentials, Docker process, lending loop, or external service is started.
const appSource = await readFile(new URL('../lib/v1/app.mjs', import.meta.url), 'utf8');
function appSection(from, to) {
  const start = appSource.indexOf(from), end = appSource.indexOf(to, start);
  assert.ok(start >= 0 && end > start, 'app test boundary must still exist');
  return appSource.slice(start, end);
}
test('app readiness, blocker headline and machine hold preserve unreadable disk reason', async () => {
  const failed = await readiness(diskWith({ '/data': new Error('EIO synthetic read failure') }));
  const normalize = new Function('report', 'safeLine', 'appRemedy',
    appSection('const checks=(report?.preflight?.checks??[])', 'const names=value=>') + 'return checks;');
  const checks = normalize({ preflight: { checks: [failed] } }, x => typeof x === 'string' ? x.slice(0, 1024) : '', c => c.fix);
  assert.equal(checks[0].reason, 'host_disk_unreadable');
  const requirements = new Function('readinessCache', 'daemonRestart',
    appSection('const readinessRequirements=', 'const hold=recoveryReadHold()') + 'return readinessRequirements;')({ checks }, null);
  assert.equal(requirements[0].cause, 'host_disk_unreadable');
  const model = lendingBlockers({docker: { installed: true, running: true, signedIn: true },readinessRequirements: requirements,intent: { on: true },agents: [{ id: 'claude', enabled: true, installed: true, signedIn: true }]});
  assert.match(model.headline, /could not read free disk space/);
  assert.doesNotMatch(model.headline, /low on disk space/);
  const hold = new Function('createGate', 'preflight',
    'const deadlineRecovery=createGate(); const updateAdmissionHeld=()=>false, hostProfiles=new Map(), settings={}, automaticTest=false, sandboxHealth={}, memberTooOld=()=>false;' +
    appSection('function machineHold()', 'let blockerCheck=') + 'return machineHold();').bind(null, recoveryGate);
  const record = new Function('createGate', 'checks',
    'let preflight; const deadlineRecovery=createGate(); const sandboxHealth={observe(){}}, settings={}, now=()=>1, noteDocker=()=>{}, dockerSignedOutFrom=()=>false;' +
    appSection('function noteChecks(checks)', 'async function checkDocker(') +
    'noteChecks(checks); return preflight;').bind(null, recoveryGate);
  for (const input of [checks, [failed]]) {
    const preflight = record(input);
    assert.equal(preflight.checks[0].reason, 'host_disk_unreadable');
    assert.equal(hold(preflight), 'host_disk_unreadable');
  }
  // Exercise the raw checkDocker report path through its real readiness and noteChecks bodies.
  // checkDocker reads through the shared default-readiness observation; the stub forwards to the real readiness().
  const raw = new Function('createGate', 'report',
    'return (async () => { let preflight, dockerCheckedAt=0, dockerSignedOut=false, observedSbxVersion=null;' +
    'const deadlineRecovery=createGate(); const recoveryReadHold=()=>null; const sandboxHealth={observe(){}}, settings={}, now=()=>1, noteDocker=()=>{}, dockerSignedOutFrom=()=>false,' +
    'backend={protectionSummary:async()=>report}, JOB_DEFAULTS={}, refreshAbort={signal:undefined},' +
    'safeLine=x=>typeof x==="string"?x.slice(0,1024):"", appRemedy=c=>c.fix, boundaryVerified=()=>null, boundaryRecords=[],' +
    'refreshTestCache=async()=>{}, dockerProblem=()=>({}), defaultReadiness=({observation})=>readiness(undefined,{observation});' +
    appSection('function noteChecks(checks)', "const SIGNED_OUT_REMEDY=") +
    appSection('async function readiness(', 'async function jobReadiness(') +
    'await checkDocker({force:true}); return preflight; })();').bind(null, recoveryGate);
  assert.equal(hold(await raw({ preflight: { checks: [failed] } })), 'host_disk_unreadable');
  assert.equal(hold(record([{ ...failed, reason: 'host_disk_low' }])), 'host_disk_low');
  assert.equal(hold(record([{ name: 'host_disk', ok: false }])), 'host_disk_low');
  for (const reason of [{}, 1, 'host_disk_unreadable\\nforged', 'other_reason']) {
    const preflight = record([{ ...failed, reason }]);
    assert.equal(Object.hasOwn(preflight.checks[0], 'reason'), false, 'only known reasons survive');
  }
});

test('resolved app home and cleanup reach backend watch on independent devices', async () => {
  const home = resolve('/fixture/external/app'), directory = join(home, 'v1');
  const build = new Function('createDeadlineRecoveryGate', 'options', 'home', 'directory', 'join', 'DockerSbxBackend','dataCleanupController',
    'return (async () => { let backend, deadlineRecovery=null; ' +
    appSection('const backendOptions={home,cleanupDirectory:', 'backend.credentialWriterBusy=') +
    'return backend; })();');
  for (const lowPath of [home, join(directory, 'sandbox-cleanup')]) {
    let received;
    class FakeDiskBackend extends DockerSbxBackend {
      constructor(options) {
        received = options;
        super({ ...options, storage: {},
          hostDiskFactory: ({ paths }) => createHostDisk({ paths,
            statPath: async p => ({ dev: p === lowPath ? 2 : 1 }),
            statfsPath: async p => ({ type: 0, bsize: 4096, blocks: 100 * GiB / 4096,
              bavail: (p === lowPath ? GiB : 47 * GiB) / 4096 }) }) });
      }
    }
    // Both app creation routes must receive exactly the same resolved paths.
    for (const options of [{}, { backendFactory: args => new FakeDiskBackend(args) }]) {
      const backend = await build(createDeadlineRecoveryGate, options, home, directory, join, FakeDiskBackend,new AbortController());
      const {onDiagnostic, ...paths} = received;
      assert.equal(typeof onDiagnostic, 'function', 'the app hands its diagnostic log to the backend');
      assert.deepEqual(paths, { home, cleanupDirectory: join(directory, 'sandbox-cleanup') });
      const reading = await backend.hostDisk.free();
      assert.equal(reading.volumes.length, 2);
      const check = await backend._hostDiskCheck();
      assert.equal(check.reason, 'host_disk_low');
      assert.match(check.detail, new RegExp(lowPath));
    }
  }
});

const darwinHome = '/fixture/user';
const darwinRoots = [
  join(darwinHome, 'Library', 'Application Support', 'com.docker.sandboxes'),
  join(darwinHome, 'Library', 'Logs', 'com.docker.sandboxes'),
  join(darwinHome, 'Library', 'Logs', 'com.docker.sandboxes', 'sandboxes', 'auditkit'),
];
function darwinDisk({ statPath, statfsPath }) {
  return createHostDisk({
    paths: () => hostDiskPaths({ platform: 'darwin', userHome: darwinHome,
      home: '/fixture/app', cleanupDirectory: '/fixture/cleanup', exists: () => false }),
    statPath, statfsPath,
  });
}
const healthyFs = () => ({ type: 0, bsize: 4096, blocks: 100 * GiB / 4096, bavail: 47 * GiB / 4096 });

test('Darwin state and logs are unconditional without replacing existing paths', () => {
  const paths = hostDiskPaths({ platform: 'darwin', userHome: darwinHome,
    home: '/fixture/app', cleanupDirectory: '/fixture/cleanup', exists: () => false });
  for (const p of [...darwinRoots, darwinHome, '/fixture/app', '/fixture/cleanup']) assert.ok(paths.includes(p), p);
  const ordinary = hostDiskPaths({ platform: 'other', userHome: darwinHome,
    home: '/fixture/app', cleanupDirectory: '/fixture/cleanup' });
  for (const p of ordinary) assert.ok(paths.includes(p), p);
});

test('Darwin auditkit descendant is watched with a healthy parent for admission and runtime', async () => {
  // Cover both the OS account and Faravan's effective (possibly overridden) sbx HOME.
  const activeHome = hostDiskPaths({ platform: 'other', userHome: darwinHome })[0];
  for (const identityHome of new Set([darwinHome, activeHome])) {
    const root = join(identityHome, 'Library', 'Logs', 'com.docker.sandboxes', 'sandboxes', 'auditkit');
    const parent = resolve(root, '..');
    let free = GiB;
    const sampled = [];
    const disk = darwinDisk({
      statPath: async p => ({ dev: p === root ? 2 : 1 }),
      statfsPath: async p => {
        sampled.push(p);
        return { ...healthyFs(), bavail: (p === root ? free : 47 * GiB) / 4096 };
      },
    });
    const reading = await disk.free();
    assert.equal(reading.volumes.length, 2, 'healthy ancestors must not hide the descendant mount');
    assert.equal(reading.free, GiB);
    assert.ok(sampled.includes(root), 'sample the actual writer destination');
    assert.notEqual(root, parent);
    assert.equal((await readiness(disk)).reason, 'host_disk_low');

    free = 47 * GiB;
    assert.equal((await readiness(disk)).ok, true);
    const r = rig(() => disk.free()), w = await watching(r, { haltMs: 0 });
    try {
      assert.equal(w.detail, null);
      free = GiB;
      await r.step();
      assert.equal(w.detail?.reason, 'host_disk_low');
      assert.equal(w.detail?.path, root);
    } finally { w.watch.stop(); }
  }
});

for (const root of darwinRoots) {
  for (const code of ['EACCES', 'EIO']) test(`Darwin ${root} fails closed on ${code}`, async () => {
    const disk = darwinDisk({
      statPath: async p => {
        if (p === root) throw Object.assign(new Error(`${code} fixture`), { code });
        return { dev: 1 };
      }, statfsPath: healthyFs,
    });
    const check = await readiness(disk);
    assert.equal(check.reason, 'host_disk_unreadable');
    assert.ok(check.detail.includes(root));
    assert.ok(check.detail.includes(code));
  });

  for (const code of ['ENOENT', 'ENOTDIR']) test(`Darwin ${root} resolves ${code} to its existing parent`, async () => {
    const parent = resolve(root, '..'), sampled = [];
    const disk = darwinDisk({
      statPath: async p => {
        if (p === root) throw Object.assign(new Error(`${code} fixture`), { code });
        return { dev: p === parent ? 2 : 1 };
      },
      statfsPath: async p => { sampled.push(p); return { ...healthyFs(), bavail: (p === parent ? GiB : 47 * GiB) / 4096 }; },
    });
    const check = await readiness(disk);
    assert.equal(check.reason, 'host_disk_low');
    assert.ok(sampled.includes(parent), 'existing parent is sampled, not silently omitted');
    assert.ok(check.detail.includes(parent));
  });

  test(`only Darwin ${root} is low on a distinct device`, async () => {
    const disk = darwinDisk({
      statPath: async p => ({ dev: p === root ? 2 : 1 }),
      statfsPath: async p => ({ ...healthyFs(), bavail: (p === root ? GiB : 47 * GiB) / 4096 }),
    });
    assert.equal((await disk.free()).volumes.length, 2, 'other paths are deduplicated by device');
    const check = await readiness(disk);
    assert.equal(check.reason, 'host_disk_low');
    assert.ok(check.detail.includes(root));
  });
}

// Execute the real prepare admission boundary without Docker or job side effects.
const backendSource = await readFile(new URL('../lib/docker-backend.mjs', import.meta.url), 'utf8');
const prepareStart = backendSource.indexOf('// Every job needs headroom;');
const prepareEnd = backendSource.indexOf('signal?.throwIfAborted?.();', prepareStart);
assert.ok(prepareStart >= 0 && prepareEnd > prepareStart, 'prepare boundary must still exist');
const prepareAdmission = new Function('validateHostDiskReading', 'HOST_DISK_HEADROOM_BYTES', 'hostDiskUnreadable', 'hostDiskLow', 'policyError',
  'return async function () {' + backendSource.slice(prepareStart, prepareEnd) + 'return reading;};')(
    validateHostDiskReading, HOST_DISK_HEADROOM_BYTES, hostDiskUnreadable, hostDiskLow,
    (reason, message, detail) => Object.assign(new Error(message), { reason, ...detail }));

for (const free of [NaN, Infinity, -Infinity, -1, undefined, null, '8589934592']) {
  for (const nested of [false, true]) test(`malformed adapter free=${String(free)}, nested=${nested} is unreadable at every boundary`, async () => {
    const reading = nested ? { free: 8 * GiB, volumes: [{ path: '/bad', free }] } : { path: '/bad', free };
    const disk = { free: async () => reading };
    assert.equal((await readiness(disk)).reason, 'host_disk_unreadable');
    await assert.rejects(() => prepareAdmission.call({ hostDisk: disk }), error => error.reason === 'host_disk_unreadable');
    const r = rig(() => disk.free()), w = await watching(r);
    try {
      assert.equal(w.detail, null);
      await r.step(); assert.equal(w.detail, null);
      await r.step();
      assert.equal(w.detail?.reason, 'host_disk_unreadable');
      assert.equal(w.detail?.path, '/bad');
    } finally { w.watch.stop(); }
  });
}

test('prepare admits exactly valid headroom but refuses valid lower values', async () => {
  for (const free of [0, 8 * GiB - 1, 8 * GiB, 9 * GiB]) {
    const disk = { free: async () => ({ free }) };
    const check = await readiness(disk);
    assert.equal(check.ok, free >= 8 * GiB);
    if (check.ok) assert.equal((await prepareAdmission.call({ hostDisk: disk })).free, free);
    else await assert.rejects(() => prepareAdmission.call({ hostDisk: disk }), error => error.reason === 'host_disk_low');
  }
});

for (const fields of [
  { bsize: 0, bavail: 47 * GiB }, { bsize: -1, bavail: 47 * GiB },
  { bsize: -1, bavail: -47 * GiB }, { bsize: 1, bavail: -1 },
  { bsize: NaN, bavail: 1 }, { bsize: Infinity, bavail: 1 },
  { bsize: 1, bavail: NaN }, { bsize: 1, bavail: Infinity },
]) test(`malformed statfs bsize=${fields.bsize}, bavail=${fields.bavail} is unreadable`, async () => {
  const disk = diskWith({ '/bad': fields });
  await assert.rejects(() => disk.free(), /invalid filesystem capacity/);
  assert.equal((await readiness(disk)).reason, 'host_disk_unreadable');
});

test('1.0 GB/s admitted at 8 GiB survives firing plus the full five-second halt above the floor', async () => {
  const rate = 1e9, haltMs = 5000;
  const r = rig(async now => ({ free: 8 * GiB - now / 1000 * rate }));
  assert.equal((await readiness(r.disk)).ok, true);
  const w = await watching(r, { haltMs });
  try {
    for (let i = 0; i < 100 && !w.detail; i++) await r.step();
    assert.equal(w.detail?.reason, 'host_disk_low');
    assert.equal(w.detail.rate, rate);
    const firedAt = r.monotonic();
    for (let i = 0; i < haltMs / 100; i++) {
      await r.step();
      assert.ok((await r.disk.free()).free > HOST_DISK_FLOOR_BYTES, 'writer continues during halt');
    }
    assert.equal(r.monotonic() - firedAt, haltMs);
    assert.equal((await r.disk.free()).free, w.detail.free - rate * haltMs / 1000);
  } finally { w.watch.stop(); }
});

test('projection equality fires without waiting a poll that would finish at the floor', async () => {
  const rate = 1e9, initial = HOST_DISK_FLOOR_BYTES + rate * 5.3;
  const r = rig(async now => ({ free: initial - now / 1000 * rate }));
  const w = await watching(r);
  try {
    await r.step(); assert.equal(w.detail, null);
    await r.step();
    assert.equal(w.detail?.projected, HOST_DISK_FLOOR_BYTES);
    assert.ok(w.detail.free - rate * 5 > HOST_DISK_FLOOR_BYTES);
  } finally { w.watch.stop(); }
});
