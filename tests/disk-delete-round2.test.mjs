import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';
import { createStoreCoordinator } from '../lib/store-lock.mjs';
import { stallHelper } from '../lib/os-lock.mjs';
import { removalEnabled, REMOVE_ARTIFACTS_ENV } from '../lib/disk-sweep-setting.mjs';
import { stageGuestRuntime } from '../lib/guest-runtime.mjs';
import { DockerSbxBackend } from '../lib/docker-backend.mjs';
import { SANDBOX_MIN_AGE_MS } from '../lib/disk-sweep-plan.mjs';
import { diskLines, diskReportOf } from '../lib/disk-report.mjs';

// Round two of the disk-removal review. Removal is off unless asked for, only items the app
// provably created can be removed, and every check runs under the store gate. The real sweeper,
// ledger, gate and backend are used; the sbx command line is a fake.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-delete-round2-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const hex = c => c.repeat(64);
const CUR = hex('a'), OLD = hex('c');
const NOW = 1_800_000_000_000;
const AGED = new Date(NOW - 5 * SANDBOX_MIN_AGE_MS).toISOString();
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const row = (tag, digest, extra = {}) => ({ id: digest.slice(0, 12), repository: ASSEMBLED, tag, flavor: 'codex', created_at: AGED, size: 1000, ...extra });
let counter = 0;
const fresh = () => { const dir = path.join(root, `case-${counter++}`); fs.mkdirSync(dir, { recursive: true }); return dir; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const tick = () => new Promise(resolve => setImmediate(resolve));
const until = async (predicate, what, ms = 4000) => { const end = Date.now() + ms; while (!predicate()) { if (Date.now() > end) throw new Error(`timed out waiting for ${what}`); await sleep(5); } };
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const NAME_A = 'wf-aaaaaaaaaaaaaaaa', NAME_B = 'wf-bbbbbbbbbbbbbbbb';

// A fake sbx. `rm(args, state)` decides what `rm` answers.
function world({ templates = [], sandboxes = [], rm = null } = {}) {
  const state = { templates: [row('0a0a0a0a0a0a0a0a', CUR), ...templates], sandboxes: [...sandboxes], calls: [] };
  return {
    state,
    calls: prefix => state.calls.filter(call => call.startsWith(prefix)),
    runSbx: async args => {
      state.calls.push(args.join(' '));
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return { code: 0, stdout: JSON.stringify(state.sandboxes), stderr: '' };
      if (a === 'template' && b === 'rm') { state.templates = state.templates.filter(t => t.id !== args[2]); return { code: 0, stdout: '', stderr: '' }; }
      if (a === 'rm') {
        if (rm) return rm(args, state);
        state.sandboxes = state.sandboxes.filter(s => s.name !== args[2]);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected ' + args.join(' '), exited: true };
    },
  };
}
function rig(w, { dir = fresh(), prepare, clock = { t: NOW }, caches = null, usage = null, removeEligible = () => true, journal = { recorded: () => true } } = {}) {
  const file = path.join(dir, 'ledger.json');
  const now = () => clock.t;
  if (prepare) prepare(createDiskLedger({ file, now }), file);
  const ledger = createDiskLedger({ file, now });
  const coordinator = createStoreCoordinator({ dir });
  const sweeper = createDiskSweeper({ ledger, coordinator, runSbx: w.runSbx, journal, pins: () => [CUR], referenced: () => new Set(),
    caches, usage, measureFree: async () => null, now, ...(removeEligible === 'setting' ? {} : { removeEligible }) });
  return { ledger, sweeper, file, dir, clock, coordinator };
}
const aged = (file, name, extra = {}) => createDiskLedger({ file, now: () => NOW - 6 * SANDBOX_MIN_AGE_MS }).recordSandbox(name, { pin: OLD, id: `id-${name}`, ...extra });
const stopped = name => ({ name, id: `id-${name}`, status: 'stopped' });
const ownedSandboxes = (...names) => (ledger, file) => { for (const name of names) aged(file, name); };

// ---------------------------------------------------------------- 1. removal is off unless asked for

test('r2/1 setting: absent, empty and unrecognized values are off; only the explicit opt-in value is on', () => {
  for (const value of [undefined, '', ' ', 'junk', '0', 'false', 'off', 'true', 'yes', 'on', '2']) {
    assert.equal(removalEnabled(value === undefined ? {} : { [REMOVE_ARTIFACTS_ENV]: value }), false, `value ${JSON.stringify(value)}`);
  }
  assert.equal(removalEnabled({ [REMOVE_ARTIFACTS_ENV]: '1' }), true);
  assert.equal(removalEnabled({ [REMOVE_ARTIFACTS_ENV]: ' 1 ' }), true);
});

for (const value of [undefined, '', 'junk']) {
  test(`r2/1 sweeper: with the setting ${value === undefined ? 'absent' : JSON.stringify(value)} an eligible stopped sandbox is reported and nothing is removed`, async () => {
    const saved = process.env[REMOVE_ARTIFACTS_ENV];
    if (value === undefined) delete process.env[REMOVE_ARTIFACTS_ENV]; else process.env[REMOVE_ARTIFACTS_ENV] = value;
    try {
      const w = world({ sandboxes: [stopped(NAME_A)] });
      const { sweeper } = rig(w, { prepare: ownedSandboxes(NAME_A), removeEligible: 'setting' });
      const summary = await sweeper.run({ trigger: 'test' });
      assert.equal(summary.removes, false);
      assert.equal(summary.eligible, 1, 'the report still says what a cleanup could free');
      assert.deepEqual(w.calls('rm '), []);
      assert.equal(summary.removed, 0);
    } finally { if (saved === undefined) delete process.env[REMOVE_ARTIFACTS_ENV]; else process.env[REMOVE_ARTIFACTS_ENV] = saved; }
  });
}

// ---------------------------------------------------------------- 2. a pre-existing runtime directory is never owned

function runtimeRoot() {
  const dir = fresh();
  const node = Buffer.from('#!guest-node ' + counter);
  const sha = createHash('sha256').update(node).digest('hex');
  fs.mkdirSync(path.join(dir, 'guest-runtime/linux-x64'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'guest-runtime/linux-x64/node'), node);
  fs.writeFileSync(path.join(dir, 'guest-runtime/manifest.json'), JSON.stringify({ 'linux-x64': { sha256: sha } }));
  return { dir, sha, node };
}
function backendWith(ledger) {
  const backend = new DockerSbxBackend({ runCommand: async () => ({ code: 0, stdout: '[]', stderr: '' }), hostDisk: { free: async () => ({ free: 2 ** 40 }) } });
  backend.diskLedger = ledger;
  return backend;
}

test('r2/2 staging says whether it made the directory', async () => {
  const { dir } = runtimeRoot();
  const home = fresh();
  const first = await stageGuestRuntime({ root: dir, arch: 'x64', home });
  const second = await stageGuestRuntime({ root: dir, arch: 'x64', home });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.dir, first.dir);
});

test('r2/2 a valid runtime that was already there, with foreign files, is used but never owned: after an upgrade and a release of roots the sweep removes nothing and reports it as unknown', async () => {
  const { dir, sha, node } = runtimeRoot();
  const home = fresh();
  const dirOfRuntime = path.join(home, 'guest-runtime', sha);
  fs.mkdirSync(dirOfRuntime, { recursive: true });
  fs.writeFileSync(path.join(dirOfRuntime, 'node'), node, { mode: 0o555 });
  fs.writeFileSync(path.join(dirOfRuntime, 'notes.txt'), 'somebody else\'s file');
  const old = new Date(NOW - 5 * 60 * 60 * 1000);
  fs.utimesSync(dirOfRuntime, old, old);

  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json'), now: () => NOW });
  const backend = backendWith(ledger);
  const runtime = await backend.guestRuntime({ root: dir, arch: 'x64', home });
  assert.equal(runtime.dir, dirOfRuntime, 'the verified runtime is still used');
  assert.deepEqual(ledger.ownedCaches(), {}, 'a directory this app did not make is never recorded as ours');

  // Upgrade: a newer runtime is current now, the old directory is no longer a root, no job uses it.
  const w = world();
  const sweeper = createDiskSweeper({ ledger, coordinator: createStoreCoordinator({ dir: home }), runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(),
    caches: () => ({ root: path.join(home, 'guest-runtime'), current: hex('9'), offer: true }), measureFree: async () => null, now: () => NOW, removeEligible: () => true });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(fs.existsSync(path.join(dirOfRuntime, 'notes.txt')), true, 'the foreign file survives');
  assert.equal(fs.existsSync(dirOfRuntime), true);
  assert.equal(summary.removed, 0);
  assert.equal(summary.notTouched.caches.count, 1, 'reported as unknown, not touched');
});

test('r2/2 a runtime directory this app made itself is recorded and can be collected once superseded', async () => {
  const { dir, sha } = runtimeRoot();
  const home = fresh();
  const ledger = createDiskLedger({ file: path.join(home, 'ledger.json'), now: () => NOW });
  const backend = backendWith(ledger);
  const runtime = await backend.guestRuntime({ root: dir, arch: 'x64', home });
  assert.equal(runtime.created, true);
  assert.ok(ledger.ownedCaches()[path.join(home, 'guest-runtime', sha)]);
});

// ---------------------------------------------------------------- 3. an unknown removal is never sent again

test('r2/3 a removal that timed out is not sent again, its identity stays fenced, and other removals go on', async () => {
  const w = world({ sandboxes: [stopped(NAME_A), stopped(NAME_B)], rm: (args, state) => { if (args[2] === NAME_A) return { code: null, stdout: '', stderr: 'timed out' }; state.sandboxes = state.sandboxes.filter(s => s.name !== args[2]); return { code: 0, stdout: '', stderr: '' }; } });
  const { sweeper, ledger } = rig(w, { prepare: ownedSandboxes(NAME_A, NAME_B) });
  await sweeper.run({ trigger: 'test' });
  assert.equal(w.calls(`rm --force ${NAME_A}`).length, 1);
  assert.equal(ledger.openOps().length, 1, 'the unknown outcome keeps its record');
  const second = await sweeper.run({ trigger: 'test' });
  assert.equal(w.calls(`rm --force ${NAME_A}`).length, 1, 'the same identity is not sent a second time');
  assert.equal(second.notTouched.removals.count, 1, 'it is reported');
  assert.equal(w.state.sandboxes.some(s => s.name === NAME_B), false, 'the other sandbox was removed');
});

test('r2/3 the record is not closed by the sandbox disappearing from a listing: the name stays reserved', async () => {
  const w = world({ sandboxes: [stopped(NAME_A)], rm: () => { throw new Error('socket hang up'); } });
  const { sweeper, ledger } = rig(w, { prepare: ownedSandboxes(NAME_A) });
  await sweeper.run({ trigger: 'test' });
  w.state.sandboxes = [];
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.openOps().length, 1, 'absence alone proves nothing about a command that may still land');
  const backend = backendWith(ledger);
  assert.ok(backend._removalConflicts(ledger, { sandbox: NAME_A }), 'a new job never takes that name');
  assert.equal(backend._removalConflicts(ledger, { sandbox: NAME_B }), null);
});

test('r2/3 an old image that nothing roots is kept, never removed, and the report says why', async () => {
  const A = row('1111111111111111', OLD);
  const w = world({ templates: [A] });
  const { sweeper, ledger } = rig(w, { prepare: l => { l.ownImages([{ ref: `${A.repository}:${A.tag}`, imageId: A.id }], 'created'); } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.calls('template rm'), []);
  assert.equal(summary.removed, 0);
  assert.ok(summary.retained.some(item => item.kind === 'image' && item.reason === 'image_cleanup_unavailable'));
  assert.equal(ledger.openOps().length, 0);
});

// ---------------------------------------------------------------- 4. no log rotation

test('r2/4 an oversized log is never renamed, even with removal on and an older copy that is a plain file', async () => {
  const dir = fresh();
  const logs = path.join(dir, 'logs');
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, 'foreign.log'), Buffer.alloc(LOG_MAX_BYTES + 100));
  fs.writeFileSync(path.join(logs, 'foreign.log.1'), 'an older copy');
  const w = world();
  const { sweeper } = rig(w, { dir, usage: { logsDir: logs } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(fs.statSync(path.join(logs, 'foreign.log')).size, LOG_MAX_BYTES + 100);
  assert.equal(fs.readFileSync(path.join(logs, 'foreign.log.1'), 'utf8'), 'an older copy');
  assert.ok(!summary.logsRotated);
});

// ---------------------------------------------------------------- 5. leases go through the gate

function leaseRig({ ttlMs = 1000, renewMs = 15 } = {}) {
  const dir = fresh();
  const clock = { t: NOW };
  const ledger = createDiskLedger({ file: path.join(dir, 'ledger.json'), now: () => clock.t });
  const backend = backendWith(ledger);
  backend.diskLease = { ttlMs, renewMs };
  const cacheDir = path.join(dir, 'guest-runtime', hex('7'));
  fs.mkdirSync(cacheDir, { recursive: true });
  return { dir, clock, ledger, backend, cacheDir, gate: () => backend._diskCoordinator() };
}

test('r2/5 a lease that ran out is not revived while the sweep holds the gate; it is admitted again, under the gate, afterwards', async t => {
  const r = leaseRig();
  const hold = r.backend._leaseHold(r.ledger, `cache:${r.cacheDir}`);
  t.after(() => r.backend._dropHold(hold));
  r.clock.t += 5000; // the holder's lease ran out (delayed process)
  const sweepGate = await r.gate().acquire({});
  await sleep(120); // several renewal ticks while the sweep holds the gate
  assert.deepEqual(r.ledger.activeLeases(), [], 'no renewal or reacquisition happens outside the gate');
  sweepGate.release();
  await until(() => r.ledger.activeLeases().length === 1, 'readmission');
  assert.equal(hold.valid, true);
});

test('r2/5 an expired holder is not readmitted while a removal of what it uses is open, and it knows it is not held', async t => {
  const r = leaseRig();
  const hold = r.backend._leaseHold(r.ledger, `cache:${r.cacheDir}`);
  t.after(() => r.backend._dropHold(hold));
  r.clock.t += 5000;
  r.ledger.beginOp({ kind: 'cache', ref: r.cacheDir });
  await sleep(120);
  assert.deepEqual(r.ledger.activeLeases(), [], 'a conflicting removal blocks readmission');
  assert.equal(hold.valid, false);
});

test('r2/5 an expired sandbox lease is not readmitted while a removal of that sandbox is open', async t => {
  const r = leaseRig();
  const hold = r.backend._leaseHold(r.ledger, `sandbox:${NAME_A}`);
  t.after(() => r.backend._dropHold(hold));
  r.clock.t += 5000;
  r.ledger.beginOp({ kind: 'sandbox', ref: NAME_A, sandboxId: `id-${NAME_A}` });
  await sleep(120);
  assert.deepEqual(r.ledger.activeLeases(), [], 'an open removal of the sandbox blocks readmission');
  assert.equal(hold.valid, false);
});

test('r2/5 an expired sandbox lease is readmitted when no removal of that sandbox is open', async t => {
  const r = leaseRig();
  const hold = r.backend._leaseHold(r.ledger, `sandbox:${NAME_A}`);
  t.after(() => r.backend._dropHold(hold));
  r.clock.t += 5000;
  r.ledger.beginOp({ kind: 'sandbox', ref: NAME_B, sandboxId: `id-${NAME_B}` });
  await until(() => r.ledger.activeLeases().length === 1, 'readmission');
  assert.equal(hold.valid, true);
});

test('r2/5 a job whose runtime hold is not valid is refused at admission, under the gate', async t => {
  const r = leaseRig({ renewMs: 3_600_000 });
  r.backend.runSbx = async () => ({ code: 0, stdout: '[]', stderr: '' });
  const hold = r.backend._leaseHold(r.ledger, `cache:${r.cacheDir}`);
  t.after(() => r.backend._dropHold(hold));
  r.clock.t += 5000;
  r.ledger.beginOp({ kind: 'cache', ref: r.cacheDir });
  await assert.rejects(r.backend._admitDiskJob(NAME_A, null, undefined, hold), error => error.code === 'disk_protection_unavailable');
  assert.deepEqual(r.ledger.activeLeases(), []);
});

test('r2/5 a lease written after the plan was read still protects the cache: the last check before removal reads leases again', async () => {
  const dir = fresh();
  const cacheRoot = path.join(dir, 'guest-runtime');
  const D = hex('5');
  fs.mkdirSync(path.join(cacheRoot, D), { recursive: true });
  const old = new Date(NOW - 5 * 60 * 60 * 1000);
  fs.utimesSync(path.join(cacheRoot, D), old, old);
  const w = world();
  const r = rig(w, { dir, caches: () => ({ root: cacheRoot, current: hex('f'), offer: true }), prepare: l => { l.ownCache(path.join(cacheRoot, D), 'created'); } });
  const other = createDiskLedger({ file: r.file, now: () => NOW });
  const beginOp = r.ledger.beginOp.bind(r.ledger);
  r.ledger.beginOp = (...args) => { const id = beginOp(...args); other.acquireLease({ item: `cache:${path.join(cacheRoot, D)}`, ttlMs: 600_000 }); return id; };
  const summary = await r.sweeper.run({ trigger: 'test' });
  assert.equal(fs.existsSync(path.join(cacheRoot, D)), true);
  assert.equal(summary.removed, 0);
});

// ---------------------------------------------------------------- 6. the gate wait

test('r2/6 a queued call on the same coordinator times out on its own deadline while the holder keeps the gate', async () => {
  const gate = createStoreCoordinator({ dir: fresh() });
  const holder = await gate.acquire({});
  try {
    const started = Date.now();
    const verdict = await Promise.race([gate.acquire({ waitMs: 30 }).then(() => 'acquired', error => error.code), sleep(1500).then(() => 'still waiting')]);
    assert.equal(verdict, 'store_busy');
    assert.ok(Date.now() - started < 1000);
  } finally { holder.release(); }
});

test('r2/6 a queued call can be cancelled, and a call behind it does not overtake the holder', async () => {
  const gate = createStoreCoordinator({ dir: fresh() });
  const holder = await gate.acquire({});
  const controller = new AbortController();
  const cancelled = gate.acquire({ signal: controller.signal });
  let behind = null;
  const behindPromise = gate.acquire({}).then(h => { behind = h; return h; });
  await sleep(20);
  controller.abort();
  const verdict = await Promise.race([cancelled.then(() => 'acquired', () => 'cancelled'), sleep(1500).then(() => 'still waiting')]);
  assert.equal(verdict, 'cancelled');
  await sleep(100);
  assert.equal(behind, null, 'the call behind the cancelled one waits for the holder');
  holder.release();
  const got = await behindPromise;
  assert.ok(got);
  got.release();
});

test('r2/6 how long a second call waits behind a slow first one: until the first ends, and no longer than its own limit', async () => {
  const gate = createStoreCoordinator({ dir: fresh() });
  const first = await gate.acquire({});
  setTimeout(() => first.release(), 150);
  const begin = Date.now();
  const second = await gate.acquire({ waitMs: 2000 });
  const waited = Date.now() - begin;
  second.release();
  assert.ok(waited >= 120 && waited < 1500, `waited ${waited} ms`);
});

test('r2/6 a stalled lock helper cannot hold the caller past its deadline, and a late grant leaves the lock free', async () => {
  const dir = fresh();
  const gate = createStoreCoordinator({ dir });
  stallHelper(400);
  const begin = Date.now();
  const verdict = await gate.acquire({ waitMs: 40 }).then(handle => { handle.release(); return 'acquired'; }, error => error.code);
  const waited = Date.now() - begin;
  assert.equal(verdict, 'store_busy');
  assert.ok(waited < 300, `refused after ${waited} ms`);
  // The helper wakes and processes the request that gave up: it must not keep a lock nobody can release.
  await sleep(500);
  const again = await gate.acquire({ waitMs: 2000 });
  again.release();
  const other = await createStoreCoordinator({ dir }).acquire({ waitMs: 2000 });
  other.release();
}, { skip: process.platform !== 'linux' && 'the lock helper is Linux-only' });

test('r2/6 a busy store reaches the user as a plain, retryable message', () => {
  const backend = backendWith(createDiskLedger({ file: path.join(fresh(), 'ledger.json') }));
  const error = backend._protectionUnavailable(Object.assign(new Error('busy'), { code: 'store_busy' }));
  assert.equal(error.code, 'disk_protection_unavailable');
  assert.match(error.message, /^Another sandbox is still being started or cleaned up in the same store, so this one waits\. Try again shortly\.$/);
});

// ---------------------------------------------------------------- 7. every entry that is not provably ours is unknown

function cacheWorld(setup) {
  const dir = fresh();
  const cacheRoot = path.join(dir, 'guest-runtime');
  fs.mkdirSync(cacheRoot, { recursive: true });
  const w = world();
  const state = { ...setup(cacheRoot) };
  const r = rig(w, { dir, caches: () => ({ root: cacheRoot, current: hex('f'), offer: true }), prepare: l => { for (const d of state.recorded ?? []) l.ownCache(d, 'created'); } });
  return { ...r, cacheRoot };
}

test('r2/7 a recorded cache replaced by a link is unknown, not touched, and its target survives', async () => {
  const c = cacheWorld(cacheRoot => {
    const target = path.join(path.dirname(cacheRoot), 'elsewhere');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'precious'), 'x');
    const D = path.join(cacheRoot, hex('4'));
    fs.symlinkSync(target, D);
    return { recorded: [D], target };
  });
  const summary = await c.sweeper.run({ trigger: 'test' });
  assert.equal(summary.notTouched.caches.count, 1);
  assert.equal(fs.existsSync(path.join(path.dirname(c.cacheRoot), 'elsewhere', 'precious')), true);
});

test('r2/7 files and names of another shape in the cache directory are unknown too', async () => {
  const c = cacheWorld(cacheRoot => { fs.writeFileSync(path.join(cacheRoot, 'README'), 'x'); fs.mkdirSync(path.join(cacheRoot, 'scratch')); fs.writeFileSync(path.join(cacheRoot, hex('3')), 'a file with a digest name'); return {}; });
  const summary = await c.sweeper.run({ trigger: 'test' });
  assert.equal(summary.notTouched.caches.count, 3);
});

test('r2/7 a cache directory that cannot be read is unknown and blocks removal; an unreadable cache root gives a partial count', async () => {
  const dir = fresh();
  const cacheRoot = path.join(dir, 'guest-runtime');
  const D = path.join(cacheRoot, hex('2'));
  fs.mkdirSync(D, { recursive: true });
  const w = world();
  const r = rig(w, { dir, caches: () => ({ root: cacheRoot, current: hex('f'), offer: true }), prepare: l => { l.ownCache(D, 'created'); } });
  const realLstat = fs.promises.lstat;
  fs.promises.lstat = async (target, ...rest) => { if (String(target) === D) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realLstat.call(fs.promises, target, ...rest); };
  let summary;
  try { summary = await r.sweeper.run({ trigger: 'test' }); } finally { fs.promises.lstat = realLstat; }
  assert.equal(summary.notTouched.caches.count, 1);
  assert.equal(fs.existsSync(D), true);

  const realOpendir = fs.promises.opendir;
  fs.promises.opendir = async (target, ...rest) => { if (String(target) === cacheRoot) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return realOpendir.call(fs.promises, target, ...rest); };
  try { summary = await r.sweeper.run({ trigger: 'test' }); } finally { fs.promises.opendir = realOpendir; }
  assert.equal(summary.notTouched.caches.partial, true);
  assert.match(diskLines(diskReportOf(summaryOf(r))).join('\n'), /cache/);
});
const summaryOf = r => r.ledger.lastSweep();

test('r2/7 a listed sandbox that is not provably ours is unknown, whatever its name', async () => {
  const w = world({ sandboxes: [{ name: 'my-own-box', id: 'x', status: 'stopped' }, { name: NAME_A, id: 'id-a', status: 'stopped' }, stopped(NAME_B)] });
  const { sweeper } = rig(w, { prepare: ownedSandboxes(NAME_B), journal: { recorded: name => name !== NAME_A } });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.equal(summary.notTouched.sandboxes.count, 2);
  assert.deepEqual(w.calls('rm ').sort(), [`rm --force ${NAME_B}`]);
});
