import './helpers/no-browser.mjs';
import './helpers/removal-on.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDiskLedger } from '../lib/disk-ledger.mjs';
import { createDiskSweeper } from '../lib/disk-sweep.mjs';
import { SANDBOX_MIN_AGE_MS } from '../lib/disk-sweep-plan.mjs';

// The safety rules of the disk sweep: what makes an item ours, what keeps it, and what is
// re-checked right before it is removed.

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-sweep-safety-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const hex = c => c.repeat(64);
const CUR = hex('a'), OLD = hex('c'), OTHER = hex('d');
const NOW = 1_800_000_000_000;
const AGED = new Date(NOW - 5 * SANDBOX_MIN_AGE_MS).toISOString();
const ASSEMBLED = 'docker.io/library/sandbox-kit-assembled';
const FOREIGN = 'other.example/team/sandbox-kit-assembled';
const row = (repository, tag, digest, extra = {}) => ({ id: digest.slice(0, 12), repository, tag, flavor: 'codex', created_at: AGED, size: 1000, ...extra });
// A stopped sandbox this app made long enough ago to be removed.
const recordOld = (file, name) => createDiskLedger({ file, now: () => NOW - 6 * SANDBOX_MIN_AGE_MS }).recordSandbox(name, { pin: OLD, id: `id-${name}` });
const box = (name, status = 'stopped') => ({ name, status });
const mine = (tag, digest, extra) => row(ASSEMBLED, tag, digest, extra);
let counter = 0;
const fresh = () => path.join(root, `case-${counter++}`);

function world({ templates, sandboxes = [], gate = null } = {}) {
  const state = { templates: [mine('0a0a0a0a0a0a0a0a', CUR), ...templates], sandboxes: [...sandboxes], calls: [] };
  return {
    state,
    removedRefs: () => state.removed ?? [],
    runSbx: async args => {
      state.calls.push(args.join(' '));
      const [a, b] = args;
      if (a === 'template' && b === 'ls') return { code: 0, stdout: JSON.stringify(state.templates), stderr: '' };
      if (a === 'ls') return { code: 0, stdout: JSON.stringify(state.sandboxes.map(sb => ({ id: `id-${sb.name}`, ...sb }))), stderr: '' };
      if (a === 'template' && b === 'rm') {
        const hit = state.templates.find(t => t.id === args[2] || `${t.repository}:${t.tag}` === args[2]); if (hit) (state.removed ??= []).push(`${hit.repository}:${hit.tag}`);
        if (gate && state.calls.filter(c => c.startsWith('template rm ')).length === 1) await gate.promise;
        state.templates = state.templates.filter(t => t !== hit);
        return { code: 0, stdout: '', stderr: '' };
      }
      if (a === 'rm') {
        (state.removed ??= []).push(args[2]);
        if (gate && state.calls.filter(c => c.startsWith('rm ')).length === 1) await gate.promise;
        state.sandboxes = state.sandboxes.filter(s => s.name !== args[2]);
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 1, stdout: '', stderr: 'unexpected ' + args.join(' ') };
    },
  };
}

// Images these tests list are ones the app made: the ledger records each with its id (nothing is adopted).
const ownListed = (ledger, w) => ledger.ownImages(w.state.templates.map(t => ({ ref: `${t.repository}:${t.tag}`, imageId: t.id })), 'created');
function rig(w, { dir = fresh(), referenced = new Set(), retained, pins = [CUR], prepare, ledger, owned = true } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'ledger.json');
  prepare?.(file);
  ledger ??= createDiskLedger({ file, now: () => NOW });
  if (owned) ownListed(ledger, w);
  const sweeper = createDiskSweeper({ ledger, runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => pins, referenced: () => referenced,
    ...(retained ? { retained: () => retained } : {}), measureFree: async () => null, now: () => NOW });
  return { ledger, sweeper, file, dir };
}

test('an image from another registry that ends in sandbox-kit-assembled is never touched', async () => {
  const w = world({ templates: [row(FOREIGN, 'foreign', OLD), mine('1111111111111111', OTHER)] });
  const { sweeper } = rig(w);
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'no image is removed, recorded or not');
});

test('an image nobody recorded is never removed, whatever its name or age', async () => {
  const w = world({ templates: [mine('1111111111111111', OLD)] });
  const { sweeper, ledger } = rig(w, { owned: false });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'there is no upgrade adoption');
  assert.deepEqual(ledger.ownedImages(), {}, 'and nothing was recorded by looking');
});

test('a retained job roots its sandbox even when it is old and recorded', async () => {
  const name = 'wf-aaaaaaaaaaaaaaaa';
  const w = world({ templates: [], sandboxes: [box(name)] });
  const { sweeper } = rig(w, { referenced: new Set([name]), prepare: file => recordOld(file, name) });
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'the retained job still needs its sandbox');
});

test('a candidate that becomes rooted while an earlier removal is pending is not removed', async () => {
  const gate = (() => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; })();
  const A = 'wf-aaaaaaaaaaaaaaaa', B = 'wf-bbbbbbbbbbbbbbbb';
  const w = world({ gate, templates: [], sandboxes: [box(A), box(B)] });
  const { sweeper, ledger } = rig(w, { prepare: file => { recordOld(file, A); recordOld(file, B); } });
  const run = sweeper.run({ trigger: 'test' });
  while (w.removedRefs().length < 1) await new Promise(resolve => setImmediate(resolve));
  // While the first removal is blocked, a job starts the second sandbox and takes a lease on it.
  const second = w.removedRefs()[0] === A ? B : A;
  w.state.sandboxes = w.state.sandboxes.map(sb => (sb.name === second ? { ...sb, status: 'running' } : sb));
  ledger.acquireLease({ item: `sandbox:${second}`, ttlMs: 60_000 });
  gate.release();
  await run;
  assert.equal(w.removedRefs().length, 1, 'only the first was removed; the second became rooted');
});

test('a damaged ledger means no destructive collection, and the sweep says so', async () => {
  const w = world({ templates: [mine('1111111111111111', OLD)] });
  const { sweeper } = rig(w, { owned: false, prepare: file => fs.writeFileSync(file, '{"version":1,"leases":') });
  const summary = await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), []);
  assert.ok(summary.errors.some(error => error.item === 'ledger'), 'the damage is reported');
  assert.equal(summary.removed, 0);
  assert.ok(summary.categories, 'measuring continues');
});

test('two instances on one store: one sweeps, the other skips with a reason', async () => {
  const gate = (() => { let release; const promise = new Promise(resolve => { release = resolve; }); return { promise, release }; })();
  const A = 'wf-aaaaaaaaaaaaaaaa', B = 'wf-bbbbbbbbbbbbbbbb';
  const w = world({ gate, templates: [], sandboxes: [box(A), box(B)] });
  const dir = fresh();
  const a = rig(w, { dir, prepare: file => { recordOld(file, A); recordOld(file, B); } });
  const b = rig(w, { dir, ledger: createDiskLedger({ file: path.join(dir, 'ledger.json'), now: () => NOW }) });
  const first = a.sweeper.run({ trigger: 'test' });
  while (w.removedRefs().length < 1) await new Promise(resolve => setImmediate(resolve));
  const second = await b.sweeper.run({ trigger: 'test' });
  assert.equal(second.skipped, 'store_busy');
  gate.release();
  await first;
  assert.equal(new Set(w.removedRefs()).size, w.removedRefs().length, 'no item was removed twice');
});

test('a lease that expired after a crash before the create changes nothing: the old image is not adopted', async () => {
  const w = world({ templates: [mine('1111111111111111', OLD)] });
  const { sweeper, ledger } = rig(w, { prepare: file => { const l = createDiskLedger({ file, now: () => NOW - 3 * SANDBOX_MIN_AGE_MS }); l.acquireLease({ item: 'image:*', ttlMs: 60_000 }); } });
  w.state.templates = w.state.templates.filter(t => t.tag !== '1111111111111111');
  await sweeper.run({ trigger: 'test' });
  w.state.templates.push(mine('1111111111111111', OLD, { created_at: new Date(NOW - 10 * SANDBOX_MIN_AGE_MS).toISOString() }));
  await sweeper.run({ trigger: 'test' });
  assert.deepEqual(w.removedRefs(), [], 'an image from before the lease is no one\'s: it is left alone');
  assert.equal(ledger.activeLeases().length, 0);
});

test('a lease that expired after a crash does not turn an unrecorded image into an owned one', async () => {
  const PREV = hex('b');
  const started = NOW - 3 * SANDBOX_MIN_AGE_MS;
  const w = world({ templates: [] });
  const { sweeper, ledger } = rig(w, { pins: [CUR], owned: false, prepare: file => {
    const l = createDiskLedger({ file, now: () => started });
    l.notePins([PREV]); l.notePins([CUR]);
    l.acquireLease({ item: 'image:*', ttlMs: 60_000 });
  } });
  w.state.templates.push(mine('3333333333333333', PREV, { created_at: new Date(started + 5000).toISOString() }));
  await sweeper.run({ trigger: 'test' });
  assert.equal(ledger.ownedImages()[`${ASSEMBLED}:3333333333333333`], undefined);
  assert.deepEqual(w.removedRefs(), []);
});

test('measuring a large retained tree yields to the event loop, stops at its budget and says the number is partial', async () => {
  const scratch = fresh();
  for (let d = 0; d < 5; d++) {
    const dir = path.join(scratch, `wf-job-wf-${String(d).repeat(16)}-job${d}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let f = 0; f < 800; f++) fs.writeFileSync(path.join(dir, `f${f}`), 'x');
  }
  const w = world({ templates: [] });
  const { ledger } = rig(w);
  const sweeper = createDiskSweeper({ ledger, runSbx: w.runSbx, journal: { recorded: () => true }, pins: () => [CUR], referenced: () => new Set(),
    usage: { scratchRoot: scratch }, accounting: { maxEntries: 1500 }, measureFree: async () => null, now: () => NOW });
  let ticks = 0, stop = false;
  const ticker = (async () => { while (!stop) { ticks++; await new Promise(resolve => setImmediate(resolve)); } })();
  const summary = await sweeper.run({ trigger: 'test' });
  stop = true; await ticker;
  assert.ok(ticks >= 10, `the event loop kept turning during accounting (${ticks} turns)`);
  assert.equal(summary.categories.workspaces.partial, true, 'a budgeted measurement is reported as partial');
  assert.equal(summary.categories.workspaces.count, 5);
});
