import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createDiskLedger} from '../lib/disk-ledger.mjs';
import {createStoreCoordinator} from '../lib/store-lock.mjs';
import {SANDBOX_MIN_AGE_MS} from '../lib/disk-sweep-plan.mjs';
import {appFixture, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';

// An install from before the reading sandboxes were deleted may still hold sandboxes an old version made for usage readings. The
// app's startup disk sweep frees them like any other recorded, unreferenced sandbox of its own, and leaves foreign ones alone.
// Fake sbx only: no sandbox runtime is reached.
const CUR = 'a'.repeat(64), OLD = 'c'.repeat(64);
const KEPT_READING = 'wf-1111111111111111', PROBE_READING = 'wf-2222222222222222', FOREIGN = 'someone-elses-box', UNRECORDED = 'wf-3333333333333333',
  YOUNG = 'wf-4444444444444444', REFERENCED = 'wf-5555555555555555';
const box = (name, status = 'stopped') => ({name, id: 'id-' + name, status});

test('after an upgrade the startup sweep removes old reading sandboxes the app recorded, and nothing else', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root), storeDir = join(f.root, 'sbx-home-remnants');
  mkdirSync(storeDir, {recursive: true});
  const ledgerFile = join(storeDir, 'disk-ledger.json'), aged = Date.now() - 6 * SANDBOX_MIN_AGE_MS;
  // The old version recorded each sandbox it made, and the current image is known to the ledger.
  const old = createDiskLedger({file: ledgerFile, now: () => aged});
  old.ownImages([{ref: 'docker.io/library/sandbox-kit-assembled:0a0a0a0a0a0a0a0a', imageId: CUR.slice(0, 12)}], 'created');
  for (const name of [KEPT_READING, PROBE_READING, FOREIGN]) old.recordSandbox(name, {pin: OLD, id: 'id-' + name});
  // Two more of the app's own: one made just now (too young to free) and one a job still names.
  const fresh = createDiskLedger({file: ledgerFile});
  fresh.recordSandbox(YOUNG, {pin: OLD, id: 'id-' + YOUNG});
  old.recordSandbox(REFERENCED, {pin: OLD, id: 'id-' + REFERENCED});
  backend.diskLedger = createDiskLedger({file: ledgerFile});
  const calls = [], listed = [box(KEPT_READING, 'running'), box(PROBE_READING), box(FOREIGN), box(UNRECORDED), box(YOUNG), box(REFERENCED)];
  let reachedRuntime = 0;
  backend.prepare = async () => { reachedRuntime++; throw new Error('no sandbox may be created'); };
  backend.start = async () => { reachedRuntime++; throw new Error('no sandbox may be started'); };
  backend.diskSweepAdapters = () => ({
    runSbx: async args => {
      calls.push(args.join(' '));
      if (args[0] === 'ls') return {code: 0, stdout: JSON.stringify(listed), stderr: ''};
      if (args[0] === 'template' && args[1] === 'ls') return {code: 0, stdout: JSON.stringify([{id: CUR.slice(0, 12), repository: 'docker.io/library/sandbox-kit-assembled', tag: '0a0a0a0a0a0a0a0a', created_at: new Date(aged).toISOString(), size: 1}]), stderr: ''};
      if (args[0] === 'rm') { const at = listed.findIndex(s => s.name === args[2]); if (at >= 0) listed.splice(at, 1); return {code: 0, stdout: '', stderr: ''}; }
      return {code: 0, stdout: '[]', stderr: ''};
    },
    journal: {recorded: name => name !== FOREIGN}, referenced: () => new Set([REFERENCED]), pins: () => [CUR],
    hostFree: async () => 2 ** 40, measureFree: async () => 2 ** 40, caches: () => null, usage: null,
    coordinator: createStoreCoordinator({dir: storeDir}),
  });
  const {app} = await f.start('reading-remnants', {backend});
  // The sweep is finished when it has written its summary to the ledger.
  await waitFor(() => readFileSync(ledgerFile, 'utf8').includes('"lastSweep":{') || JSON.parse(readFileSync(ledgerFile, 'utf8')).lastSweep, 'the startup sweep to finish', 20000);
  const removed = calls.filter(c => c.startsWith('rm ')).map(c => c.split(' ')[2]);
  // Exactly one sandbox is freed: the stopped, aged, recorded, unreferenced old reading sandbox.
  assert.deepEqual(removed, [PROBE_READING], 'removed set: ' + calls.join(' | '));
  // The running old reading sandbox is kept: a sweep never stops or removes a running sandbox.
  assert.ok(listed.some(s => s.name === KEPT_READING && s.status === 'running'), 'the running remnant is left running');
  assert.deepEqual(listed.map(s => s.name).sort(), [KEPT_READING, FOREIGN, UNRECORDED, YOUNG, REFERENCED].sort(), 'the survivors, including the young and the referenced one');
  assert.equal(reachedRuntime, 0, 'the sweep and the new readings create and start no sandbox');
  await app.close();
});
