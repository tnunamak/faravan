import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync, existsSync, writeFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {createDiskLedger} from '../lib/disk-ledger.mjs';
import {createStoreCoordinator} from '../lib/store-lock.mjs';
import {acquireProcessLock} from '../lib/v1/lock.mjs';
import {appFixture,syntheticBackend,waitFor,api} from './helpers/v1-app-fixture.mjs';
import {REMOVE_ARTIFACTS_ENV} from '../lib/disk-sweep-setting.mjs';

// The app wires the disk sweep behind readiness and gives the backend the ledger.
let stores = 0;
function sweepingBackend(root, events) {
  const backend = syntheticBackend(root);
  // The record lives in the sbx HOME, with the gate of its writers; this stands in for that directory.
  const storeDir = join(root, `sbx-home-${stores++}`);
  mkdirSync(storeDir, {recursive: true});
  backend.diskLedger = createDiskLedger({file: join(storeDir, 'disk-ledger.json')});
  const probe = backend.probeCapabilities.bind(backend);
  backend.probeCapabilities = async () => { events.push('probe-start'); await new Promise(resolve => setTimeout(resolve, 60)); const report = await probe(); events.push('probe-done'); return report; };
  backend.diskSweepAdapters = () => ({
    runSbx: async args => { events.push(args.slice(0, 2).join(' ')); return args[0] === 'template' ? {code: 0, stdout: '[]', stderr: ''} : {code: 0, stdout: '[]', stderr: ''}; },
    journal: {recorded: () => true}, referenced: () => new Set(), pins: () => ['a'.repeat(64)],
    hostFree: async () => 2 ** 40, measureFree: async () => 2 ** 40, caches: () => null, usage: null,
    coordinator: createStoreCoordinator({dir: storeDir}),
  });
  return backend;
}

test('the disk sweep starts only after readiness, records its result, and stops with the app', {timeout: 60000}, async t => {
  const f = await appFixture(t), home = await f.home('disk-sweep');
  const events = [];
  const backend = sweepingBackend(f.root, events);
  const {app} = await f.start('disk-sweep', {backend});
  await waitFor(() => events.includes('template ls'), 'the startup sweep', 5000);
  const firstSweep = events.indexOf('template ls');
  assert.ok(events.slice(0, firstSweep).includes('probe-done'), 'a readiness check finished before the sweep began: ' + events.join(','));
  assert.ok(backend.diskLedger, 'the backend was given the ledger');
  const file = backend.diskLedger.file;
  await waitFor(() => existsSync(file) && JSON.parse(readFileSync(file, 'utf8')).lastSweep, 'the recorded sweep', 5000);
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(ledger.lastSweep.trigger, 'startup');
  assert.deepEqual(ledger.pins.current, ['a'.repeat(64)]);
  await app.close();
});

test('an app without the sweep option or without backend support runs none', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const events = [];
  const off = sweepingBackend(f.root, events);
  await f.start('disk-sweep-off', {backend: off, diskSweep: false});
  const plain = syntheticBackend(f.root);
  await f.start('disk-sweep-plain', {backend: plain});
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.ok(!events.includes('template ls'));
  assert.equal(plain.diskLedger, undefined);
});

test('the shared home and status payloads carry the disk report once a computer sweeps, and omit it otherwise', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const {app} = await f.start('disk-status', {backend: sweepingBackend(f.root, [])});
  await waitFor(async () => (await api(app, '/api/status')).disk?.last_sweep, 'the sweep result in the status payload', 5000);
  for (const route of ['/api/status', '/api/home']) {
    const view = await api(app, route);
    assert.equal(view.disk.last_sweep.trigger, 'startup', route);
    assert.ok('images' in view.disk.categories, route);
    assert.equal(view.disk.last_sweep.categories, undefined, 'categories are lifted out of last_sweep');
  }
  const viaOp = await api(app, '/api/ops/status.get', {method: 'POST', body: {}});
  assert.equal(viaOp.disk.last_sweep.trigger, 'startup');
  const plain = await f.start('disk-status-plain', {backend: syntheticBackend(f.root)});
  assert.equal('disk' in (await api(plain.app, '/api/status')), false);
});

test('Quit aborts a sweep whose removal is blocked: close ends inside its bound and nothing runs after it', {timeout: 60000}, async t => {
  // The removal code is kept behind one setting, off by default; this test is about that code.
  process.env[REMOVE_ARTIFACTS_ENV] = '1';
  t.after(() => { delete process.env[REMOVE_ARTIFACTS_ENV]; });
  const f = await appFixture(t);
  const events = [];
  const backend = syntheticBackend(f.root);
  const BOX = 'wf-00000000000000a1';
  backend.diskSweepAdapters = () => ({
    runSbx: async args => {
      events.push([Date.now(), args.slice(0, 2).join(' ')]);
      if (args[0] === 'template' && args[1] === 'ls') return {code: 0, stderr: '', stdout: '[]'};
      if (args[0] === 'ls') return {code: 0, stderr: '', stdout: JSON.stringify([{name: BOX, id: 'id-' + BOX, status: 'stopped'}])};
      return new Promise(() => {}); // a removal that never answers and ignores any signal
    },
    journal: {recorded: () => true}, referenced: () => new Set(), pins: () => ['a'.repeat(64)],
    hostFree: async () => 2 ** 40, measureFree: async () => 2 ** 40, caches: () => null, usage: null,
    coordinator: createStoreCoordinator({dir: f.root}),
  });
  const diskLedger = createDiskLedger({file: join(f.root, 'quit-ledger.json')});
  createDiskLedger({file: diskLedger.file, now: () => Date.now() - 24 * 3600 * 1000}).recordSandbox(BOX, {pin: 'a'.repeat(64), id: 'id-' + BOX});
  const {app} = await f.start('disk-quit', {backend, diskLedger, shutdownProofMs: 600});
  await waitFor(() => events.some(([, what]) => what === 'rm --force'), 'the blocked removal', 8000);
  const began = Date.now();
  const closed = await Promise.race([app.close().then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('stuck'), 5000))]);
  const took = Date.now() - began;
  assert.equal(closed, 'closed', 'Quit does not wait for a removal that never answers');
  assert.ok(took < 3000, `close took ${took} ms`);
  const count = events.length;
  await new Promise(resolve => setTimeout(resolve, 400));
  assert.equal(events.length, count, 'no sbx operation after Quit');
});

test('a low drive is warned about in the status payload and the notification feed, and a drive with room is not', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const lowBackend = sweepingBackend(f.root, []);
  const adapters = lowBackend.diskSweepAdapters;
  const GiB = 1024 ** 3;
  lowBackend.diskSweepAdapters = () => ({...adapters(), hostFree: async () => 6 * GiB, measureFree: async () => 6 * GiB});
  const {app} = await f.start('disk-low', {backend: lowBackend});
  await waitFor(async () => (await api(app, '/api/status')).disk?.warning, 'the low-space warning in the status payload', 5000);
  const view = await api(app, '/api/status');
  assert.equal(view.disk.warning.kind, 'disk_space_low');
  assert.equal(view.disk.warning.free_bytes, 6 * GiB);
  assert.ok('images' in view.disk.warning.by_kind && 'sandboxes' in view.disk.warning.by_kind && 'caches' in view.disk.warning.by_kind && 'logs' in view.disk.warning.by_kind);
  await waitFor(async () => (await api(app, '/api/notifications')).history.some(row => row.kind === 'disk_space_low'), 'the notification', 5000);
  const note = (await api(app, '/api/notifications')).history.find(row => row.kind === 'disk_space_low');
  assert.equal(note.route, '#/lend');
  assert.match(note.body, /Low disk space: 6\.4 GB is free/);

  const fine = await f.start('disk-roomy', {backend: sweepingBackend(f.root, [])});
  await waitFor(async () => (await api(fine.app, '/api/status')).disk?.last_sweep, 'the sweep result', 5000);
  assert.equal((await api(fine.app, '/api/status')).disk.warning, null);
  assert.equal((await api(fine.app, '/api/notifications')).history.some(row => row.kind === 'disk_space_low'), false);
});

test('startup does not warn from a saved low disk reading while the live observation is pending', {timeout:60000}, async t => {
  const f = await appFixture(t);
  const backend = sweepingBackend(f.root, []);
  const adapters = backend.diskSweepAdapters;
  const low = 6 * 1024 ** 3;
  const healthy = 2 ** 40;
  backend.diskLedger.recordSweep({at:1, trigger:'startup', storeFreeBytes:low});
  const reading = Promise.withResolvers();
  backend.diskSweepAdapters = () => {
    const disk = adapters();
    return {...disk, hostFree: () => reading.promise, async runSbx(...args) {
      await reading.promise;
      return disk.runSbx(...args);
    }};
  };
  const {app} = await f.start('disk-wait-for-current-reading', {backend});

  try {
    const initial = (await api(app, '/api/status')).disk;
    assert.equal(initial.last_sweep.storeFreeBytes, low);
    assert.equal(initial.store_free_bytes, null);
    assert.equal(initial.warning, null);
  } finally {
    reading.resolve(healthy);
  }
  await waitFor(async () => (await api(app, '/api/status')).disk?.store_free_bytes === healthy, 'current free space', 10000);
  assert.equal((await api(app, '/api/status')).disk.warning, null);
  assert.equal((await api(app, '/api/notifications')).history.some(row => row.kind === 'disk_space_low'), false);
});

test('partial startup sweep agrees across Home, Status, and the low-space notice', {timeout: 60000}, async t => {
  const savedRemoval = process.env[REMOVE_ARTIFACTS_ENV];
  process.env[REMOVE_ARTIFACTS_ENV] = '0';
  t.after(() => {
    if (savedRemoval === undefined) delete process.env[REMOVE_ARTIFACTS_ENV];
    else process.env[REMOVE_ARTIFACTS_ENV] = savedRemoval;
  });
  const f = await appFixture(t);
  const backend = sweepingBackend(f.root, []);
  const adapters = backend.diskSweepAdapters;
  const calls = [], low = 6 * 1024 ** 3;
  backend.diskSweepAdapters = () => ({
    ...adapters(),
    hostFree: async () => low,
    measureFree: async () => low,
    runSbx: async args => {
      calls.push([...args]);
      if (args[0] === 'template' && args[1] === 'ls' && args[2] === '--json' && args.length === 3) {
        return {code: 0, stderr: '', stdout: JSON.stringify([{
          repository: 'docker.io/library/sandbox-kit-assembled',
          tag: '1111111111111111', image_id: 'c'.repeat(12), size: 2 * 1024 ** 3,
          created: '2026-01-01T00:00:00Z',
        }])};
      }
      if (args[0] === 'ls' && args[1] === '--json' && args.length === 2)
        return {code: 1, stdout: '', stderr: 'synthetic sandbox listing failed'};
      assert.fail('report-only startup must not request another sbx operation');
    },
  });
  const {app} = await f.start('disk-partial-startup', {backend});
  await waitFor(async () => (await api(app, '/api/status')).disk?.last_sweep?.trigger === 'startup',
    'the persisted partial startup report', 5000);

  const status = (await api(app, '/api/status')).disk;
  const home = (await api(app, '/api/home')).disk;
  assert.deepEqual(home, status);
  assert.equal(status.last_sweep.removes, false);
  assert.equal(status.last_sweep.removed, 0);
  assert.equal(status.last_sweep.listingsComplete, false);
  assert.equal(status.last_sweep.expectedPartial, true);
  assert.equal(status.last_sweep.expectedBytes, null);
  assert.deepEqual(status.last_sweep.errors.map(error => error.item), ['sandbox-listing']);
  assert.equal(status.categories.images.count, 1);
  assert.equal(status.categories.sandboxes.count, null);
  assert.equal(status.warning.kind, 'disk_space_low');
  assert.equal(status.warning.free_bytes, low);
  assert.equal(status.warning.by_kind.sandboxes.count, null);
  assert.equal(status.warning.could_free_partial, true);
  assert.equal(status.warning.could_free_bytes, null);

  const notice = async () => (await api(app, '/api/notifications')).history.find(row =>
    row.kind === 'disk_space_low' && /images 1\b/.test(row.body));
  const note = await waitFor(notice, 'the low-space notice using the saved partial report', 5000);
  assert.match(note.body, /Low disk space: 6\.4 GB is free/);
  assert.match(note.body, /sandboxes unknown/);
  assert.match(note.body, /could free: unknown/);
  assert.match(note.body, /Disk cleanup is turned off/);
  assert.doesNotMatch(note.body, /sandboxes 0|could free \d/);
  const {history} = await api(app, '/api/notifications');
  assert.deepEqual(history.filter(row => row.kind === 'disk_space_low').map(row => row.id), [note.id]);
  assert.deepEqual(calls, [['template', 'ls', '--json'], ['template', 'ls', '--json'], ['ls', '--json']]);
});

test('a damaged record file does not hide a low-drive warning in the status payload or the notification feed', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const home = await f.home('disk-damaged-low');
  const backend = sweepingBackend(f.root, []);
  const file = backend.diskLedger.file;
  const bytes = JSON.stringify({version: 3, leases: {}, sandboxes: {}, pins: {current: [], previous: []}, lastSweep: {at: 1, trigger: 'startup', categories: []}, owned: {images: {}, caches: {}}, ops: {}});
  writeFileSync(file, bytes);
  const adapters = backend.diskSweepAdapters;
  const GiB = 1024 ** 3;
  backend.diskSweepAdapters = () => ({...adapters(), hostFree: async () => 6 * GiB, measureFree: async () => 6 * GiB});
  const {app} = await f.start('disk-damaged-low', {backend, home});
  await waitFor(async () => (await api(app, '/api/status')).disk?.warning, 'the low-space warning beside the damage', 5000);
  const view = await api(app, '/api/status');
  assert.equal(view.disk.damaged, true);
  assert.equal(view.disk.warning.by_kind.images.count, null);
  assert.equal(view.disk.warning.could_free_bytes, null);
  await waitFor(async () => (await api(app, '/api/notifications')).history.some(row => row.kind === 'disk_space_low'), 'the notification', 5000);
  assert.equal(readFileSync(file, 'utf8'), bytes, 'the damaged file is untouched');
});

function readIfPresent(file) {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

for (const trigger of ['startup', 'timer', 'pressure', 'doctor', 'update', 'settled']) {
  test(`close reports and drains held ${trigger} disk work`, {timeout: 60000}, async t => {
    const fs = await import('node:fs');
    const {AppLifetime} = await import('../lib/v1/app-lifetime.mjs');
    const {createDiskSweeper} = await import('../lib/disk-sweep.mjs');
    const {PRESSURE_CHECK_MS} = await import('../lib/disk-sweep-schedule.mjs');
    const f = await appFixture(t);
    const home = await f.home('disk-close-' + trigger);
    const cacheRoot = join(f.root, 'delayed-cache-' + trigger);
    mkdirSync(cacheRoot);

    const hold = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const update = trigger === 'update' || trigger === 'settled';
    const startup = trigger === 'startup' || update;
    const appLock = join(home, 'v1', 'app.lock');
    let relaunches = 0;
    let armed = startup;
    let held = false;
    async function holdRead() {
      if (!armed || held) return;
      held = true;
      entered.resolve();
      await hold.promise;
    }

    // Join the same producer drain the app starts during close, even if its bounded wait expires.
    const register = AppLifetime.prototype.register;
    const diskDrain = Promise.withResolvers();
    t.mock.method(AppLifetime.prototype, 'register', function (name, phase, hooks) {
      if (name !== 'disk sweep') return register.call(this, name, phase, hooks);
      return register.call(this, name, phase, {...hooks, drain() {
        const completion = hooks.drain();
        diskDrain.resolve(completion);
        return completion;
      }});
    });

    const callbacks = [];
    const set = globalThis.setTimeout;
    t.mock.method(globalThis, 'setTimeout', (fn, ms, ...args) => {
      if (new Error().stack.includes('disk-sweep-schedule.mjs')) {
        const handle = {unref() {}, fn, ms};
        callbacks.push(handle);
        return handle;
      }
      return set(fn, ms, ...args);
    });
    const opendir = fs.promises.opendir.bind(fs.promises);
    t.mock.method(fs.promises, 'opendir', async (...args) => {
      if ((trigger === 'timer' || trigger === 'doctor') && args[0] === cacheRoot) await holdRead();
      return opendir(...args);
    });

    const backend = syntheticBackend(f.root);
    const storeDir = join(f.root, 'close-store-' + trigger);
    mkdirSync(storeDir);
    backend.diskLedger = createDiskLedger({file: join(storeDir, 'disk-ledger.json')});
    const recordSweep = t.mock.method(backend.diskLedger, 'recordSweep');
    const hostFree = async () => {
      if (startup || trigger === 'pressure') await holdRead();
      return armed && trigger !== 'settled' ? 1 : 2 ** 40;
    };
    const adapters = {runSbx: async () => ({code: 0, stdout: '[]'}), journal: {recorded: () => false},
      referenced: () => new Set(), pins: () => [], hostFree, measureFree: async () => 2 ** 40,
      caches: {root: cacheRoot}, usage: null};
    backend.diskSweepAdapters = () => adapters;
    const effects = () => ({ledger: readIfPresent(backend.diskLedger.file), records: recordSweep.mock.callCount(),
      notes: readIfPresent(join(home, 'v1', 'notifications.json')), timers: callbacks.length});

    let work;
    try {
      const {app} = await f.start('disk-close-' + trigger, {
        backend, shutdownProofMs: trigger === 'settled' ? 3000 : 250, relaunch: () => { relaunches++; },
      });
      let doctor;
      if (!startup) {
        await waitFor(() => callbacks.some(row => row.ms === PRESSURE_CHECK_MS), 'startup disk work settled', 8000);
        armed = true;
        if (trigger === 'doctor') {
          doctor = createDiskSweeper({ledger: backend.diskLedger, ...adapters});
          work = doctor.run({trigger: 'doctor'});
        } else {
          const callback = callbacks.find(row => trigger === 'pressure' ? row.ms === PRESSURE_CHECK_MS : row.ms > PRESSURE_CHECK_MS);
          work = callback.fn();
        }
      }
      await entered.promise;

      if (trigger === 'settled') {
        hold.resolve();
        await waitFor(() => callbacks.some(row => row.ms === PRESSURE_CHECK_MS), 'released startup disk work settled', 8000);
        assert.equal(recordSweep.mock.callCount(), 1);
        const result = await app.close('update');
        assert.equal(result.state, 'closed');
        assert.deepEqual(result.unfinished, []);
        await diskDrain.promise;
        const release = await acquireProcessLock(appLock, {timeoutMs: 0});
        release();
        assert.equal(relaunches, 1, 'settled update may relaunch exactly once');
        return;
      }

      doctor?.abort();
      const result = await app.close(update ? 'update' : 'close');
      if (doctor) {
        assert.ok(!result.unfinished.includes('disk sweep'), 'the doctor owns its separate sweep');
      } else {
        assert.equal(result.state, 'interrupted');
        assert.ok(result.unfinished.includes('disk sweep'));
      }
      const atClose = effects();
      hold.resolve();
      const summary = await work;
      await diskDrain.promise;
      if (doctor) assert.equal(summary.aborted, true);
      if (update) {
        assert.equal(relaunches, 0, 'an interrupted update cannot relaunch, even after the delayed read settles');
        await assert.rejects(async () => {
          const release = await acquireProcessLock(appLock, {timeoutMs: 0});
          release();
        }, {code: 'lock_busy'}, 'the closing app retains its profile lock');
      }
      assert.deepEqual(effects(), atClose, 'settled work leaves disk records, notifications and timers untouched');
    } finally {
      hold.resolve();
      await work;
    }
  });
}
