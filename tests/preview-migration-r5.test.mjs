import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {generateKeyPairSync} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {once} from 'node:events';
import {migratePreviewProfile} from '../lib/preview-migration.mjs';
import {acquireProcessLockSync, profileWriterLockPath} from '../lib/v1/lock.mjs';
import {saveJsonFile} from '../lib/local-state.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'preview-r5-'));
  t.after(() => fs.rmSync(root, {recursive:true, force:true}));
  const source = path.join(root, 'source'), destination = path.join(root, 'data', 'preview');
  fs.mkdirSync(path.dirname(destination));
  seed(source);
  return {root, source, destination, base:root};
}

function seed(home) {
  fs.mkdirSync(path.join(home, 'v1'), {recursive:true});
  fs.writeFileSync(path.join(home, 'v1/state.json'), JSON.stringify({version:1, circles:[], generation:'original'}));
  fs.writeFileSync(path.join(home, 'v1/device.pem'), generateKeyPairSync('ed25519').privateKey.export({type:'pkcs8', format:'pem'}));
}

function syncTrace(t) {
  const events = [], sync = fs.fsyncSync, open = fs.openSync;
  t.mock.method(fs, 'fsyncSync', fd => {
    events.push(['sync', fs.readlinkSync(`/proc/self/fd/${fd}`)]);
    return sync(fd);
  });
  t.mock.method(fs, 'openSync', (file, ...args) => {
    if (String(file).includes('/.faravan-preview-record.')) events.push(['publish', String(file)]);
    return open(file, ...args);
  });
  return events;
}

test('migration syncs the data-home ancestor before publication', t => {
  const f = fixture(t), events = syncTrace(t);
  migratePreviewProfile(f);
  const parentSync = events.findIndex(([kind, file]) => kind === 'sync' && file === f.root);
  const publication = events.findIndex(([kind]) => kind === 'publish');
  assert.ok(parentSync >= 0 && parentSync < publication, JSON.stringify(events));
});

test('saveJsonFile syncs new ancestor entries in order before the file', t => {
  const f = fixture(t), events = syncTrace(t);
  const profile = path.join(f.root, 'nested', 'profile'), file = path.join(profile, 'v1/state.json');
  saveJsonFile(file, {version:1, circles:[]}, {base:f.root});
  const parents = [f.root, path.join(f.root, 'nested'), profile];
  const positions = parents.map(parent => events.findIndex(([kind, file]) => kind === 'sync' && file === parent));
  assert.ok(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1])), JSON.stringify(events));
  const fileSync = events.findIndex(([kind, name]) => kind === 'sync' && path.dirname(name) === path.dirname(file) && name.endsWith('.tmp'));
  assert.ok(fileSync > positions.at(-1), 'all parent entries precede the file commit');
});

for (const operation of ['migration', 'save']) {
  for (const depth of [0, 1, 2]) {
    test(`${operation} ancestor sync failure at depth ${depth} refuses and retry re-syncs`, t => {
      const f = fixture(t), profile = path.join(f.root, 'new', 'profile');
      const parent = [f.root, path.join(f.root, 'new'), profile][depth];
      const destination = path.join(profile, 'v1', 'preview');
      const file = path.join(profile, 'v1', 'state.json');
      const run = () => operation === 'migration'
        ? migratePreviewProfile({source:f.source, destination, base:f.root})
        : saveJsonFile(file, {version:1, circles:[]}, {base:f.root});
      const sync = fs.fsyncSync;
      const failure = Object.assign(new Error('ancestor fsync EIO'), {code:'EIO'});
      const hook = t.mock.method(fs, 'fsyncSync', fd => {
        if (fs.readlinkSync(`/proc/self/fd/${fd}`) === parent) throw failure;
        return sync(fd);
      });
      try { assert.throws(run, error => error === failure); }
      finally { hook.mock.restore(); }
      assert.equal(fs.existsSync(operation === 'migration' ? destination : file), false);
      assert.equal(fs.readFileSync(path.join(f.source, 'v1/state.json'), 'utf8'), JSON.stringify({version:1, circles:[], generation:'original'}));
      const events = syncTrace(t);
      run();
      assert.ok(events.some(([kind, name]) => kind === 'sync' && name === parent), 'a retained directory does not bypass the failed sync');
    });
  }
}

for (const unreadable of [false, true]) {
test(`unproven destination refuses ${unreadable ? 'source EACCES' : 'different device keys'} untouched`, t => {
  const f = fixture(t);
  seed(f.destination);
  const capture = home => fs.readdirSync(path.join(home, 'v1')).sort().map(name =>
    [name, fs.readFileSync(path.join(home, 'v1', name), 'base64')]);
  const sourceBefore = capture(f.source), destinationBefore = capture(f.destination);
  assert.notEqual(sourceBefore.find(([name]) => name === 'device.pem')[1], destinationBefore.find(([name]) => name === 'device.pem')[1]);
  if (unreadable) fs.chmodSync(f.source, 0);
  try {
    if (unreadable) assert.throws(() => fs.readdirSync(f.source), {code:'EACCES'});
    assert.throws(() => migratePreviewProfile(f), unreadable ? undefined : /reconciliation/);
  } finally { if (unreadable) fs.chmodSync(f.source, 0o700); }
  assert.deepEqual(capture(f.source), sourceBefore);
  assert.deepEqual(capture(f.destination), destinationBefore);
  assert.deepEqual(fs.readdirSync(path.dirname(f.destination)), ['preview']);
  assert.equal(fs.existsSync(path.join(f.destination, '.migration-complete')), false);
});
}

test('migration refuses a busy or unknown writer gate without publishing', t => {
  const f = fixture(t), gate = profileWriterLockPath(f.source);
  const before = fs.readFileSync(path.join(f.source, 'v1/state.json'), 'utf8');
  const release = acquireProcessLockSync(gate);
  try { assert.throws(() => migratePreviewProfile(f), {code:'lock_busy'}); }
  finally { release(); }
  fs.writeFileSync(path.join(gate + '.owners-v1', 'unknown-owner'), 'do not steal');
  assert.throws(() => migratePreviewProfile(f), {code:'lock_busy'});
  assert.equal(fs.existsSync(f.destination), false);
  assert.equal(fs.readFileSync(path.join(f.source, 'v1/state.json'), 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(gate + '.owners-v1', 'unknown-owner'), 'utf8'), 'do not steal');
});

test('a state writer starting at snapshot publication is excluded', t => {
  const f = fixture(t), stateFile = path.join(f.source, 'v1/state.json');
  const before = fs.readFileSync(stateFile, 'utf8');
  const writer = `
    import {acquireProcessLockSync} from ${JSON.stringify(new URL('../lib/v1/lock.mjs', import.meta.url).href)};
    import {saveJsonFile} from ${JSON.stringify(new URL('../lib/local-state.mjs', import.meta.url).href)};
    let release;
    try { release = acquireProcessLockSync(${JSON.stringify(path.join(f.source, 'v1/state.lock'))}); }
    catch (error) { if (error.code === 'lock_busy') process.exit(42); throw error; }
    try { saveJsonFile(${JSON.stringify(stateFile)}, {version:1, circles:[], generation:'newer'}, {base:${JSON.stringify(f.source)}}); }
    finally { release(); }
  `;
  const open = fs.openSync;
  let status;
  fs.openSync = function(file, ...args) {
    if (status === undefined && String(file).includes('/.faravan-preview-record.')) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {encoding:'utf8', timeout:5000});
      assert.equal(child.signal, null, child.stderr);
      status = child.status;
    }
    return open.call(this, file, ...args);
  };
  try { migratePreviewProfile(f); } finally { fs.openSync = open; }
  assert.equal(status, 42, 'the real state lock blocks the late writer');
  assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  assert.equal(fs.readFileSync(path.join(f.destination, 'v1/state.json'), 'utf8'), before);
});

for (const writerKind of ['device', 'app']) {
test(`a fresh migration excludes a ${writerKind} initializing the absent source`, t => {
  const f = fixture(t);
  fs.renameSync(f.source, path.join(f.root, 'retained-profile'));
  const writer = writerKind === 'device' ? `
    import {openDevice} from ${JSON.stringify(new URL('../lib/v1/device.mjs', import.meta.url).href)};
    try { await openDevice({home:${JSON.stringify(f.source)}, origin:null}); }
    catch (error) { if (error.code === 'device_busy') process.exit(42); throw error; }
  ` : `
    import {startApp} from ${JSON.stringify(new URL('../lib/v1/app.mjs', import.meta.url).href)};
    try { const app = await startApp({home:${JSON.stringify(f.source)}, port:0, freshLending:'off'}); await app.close(); }
    catch (error) { if (error.code === 'app_already_running') process.exit(42); throw error; }
  `;
  const open = fs.openSync;
  let status;
  fs.openSync = function(file, ...args) {
    if (status === undefined && String(file).includes('/.faravan-preview-record.')) {
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', writer], {encoding:'utf8', timeout:5000});
      assert.equal(child.signal, null, child.stderr);
      status = child.status;
    }
    return open.call(this, file, ...args);
  };
  try { migratePreviewProfile(f); } finally { fs.openSync = open; }
  assert.equal(status, 42, 'initialization must take the gate even when no source exists yet');
  assert.equal(fs.existsSync(f.source), false);
});
}

for (const operation of ['intent-set', 'intent-delete', 'roster', 'owner-roster']) {
test(`an already-open device excludes ${operation} during snapshot publication`, async t => {
  const f = fixture(t), barrier = new Int32Array(new SharedArrayBuffer(8));
  const worker = new Worker(`
    const {parentPort, workerData} = require('node:worker_threads');
    (async () => {
      const {openDevice} = await import(workerData.module);
      const device = await openDevice({home:workerData.home, origin:null});
      const circle = (await device.listCircles())[0];
      await device.intentStore(circle.id).set('late-writer', {generation:'original'});
      const roster = await device.rosterCache(circle.id).get();
      const barrier = new Int32Array(workerData.barrier);
      parentPort.postMessage('ready');
      Atomics.wait(barrier, 0, 0, 10000);
      let result = 1;
      try {
        if (workerData.operation === 'intent-set') await device.intentStore(circle.id).set('late-writer', {generation:'newer'});
        if (workerData.operation === 'intent-delete') await device.intentStore(circle.id).delete('late-writer');
        if (workerData.operation === 'roster') await device.rosterCache(circle.id).set(roster);
        if (workerData.operation === 'owner-roster') await device.createCircle(null, {name:'Another circle', reuse:false});
      }
      catch (error) { result = error.code === 'device_busy' ? 2 : 3; }
      Atomics.store(barrier, 1, result);
      Atomics.notify(barrier, 1);
    })().catch(error => { throw error; });
  `, {eval:true, workerData:{module:new URL('../lib/v1/device.mjs', import.meta.url).href, home:f.source, barrier:barrier.buffer, operation}});
  t.after(() => worker.terminate());
  await once(worker, 'message');
  const open = fs.openSync;
  let reached = false;
  fs.openSync = function(file, ...args) {
    if (!reached && String(file).includes('/.faravan-preview-record.')) {
      reached = true;
      Atomics.store(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      assert.notEqual(Atomics.wait(barrier, 1, 0, 12000), 'timed-out');
    }
    return open.call(this, file, ...args);
  };
  try { migratePreviewProfile(f); } finally { fs.openSync = open; }
  assert.equal(reached, true);
  assert.equal(Atomics.load(barrier, 1), 2, 'a device opened before migration must be excluded too');
});
}
