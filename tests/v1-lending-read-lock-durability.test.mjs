import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLendingLedger } from '../lib/v1/lending-ledger.mjs';
import { acquireProcessLockSync } from '../lib/v1/lock.mjs';

const HOUR = 3600000;
const clock = Date.parse('2026-10-21T23:00:00Z');
const RESET = clock + 2 * 24 * HOUR;
const week = (used) => ({ window_id: 'seven_day', window_minutes: 10080, used_pct: used, resets_at: RESET, observed_at: clock, state: 'open', source: 'probe' });

// Each entry says whether one fsync(2) call targeted a directory (the lock's and the ledger's durability barrier).
function recordFsyncs(fn) {
  const calls = [];
  const original = fs.fsyncSync;
  fs.fsyncSync = fd => { calls.push(fs.fstatSync(fd).isDirectory() ? 'directory' : 'file'); return original(fd); };
  try { fn(); } finally { fs.fsyncSync = original; }
  return calls;
}

function scratch(t) {
  const base = join(homedir(), '.tmp');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'lending-read-durability-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('read-only ledger calls take no directory fsync, and a write keeps its directory fsync', (t) => {
  const dir = scratch(t);
  const ledger = createLendingLedger({ file: join(dir, 'ledger.json'), now: () => clock });

  const writes = recordFsyncs(() => ledger.recordReadings('claude', [week(10)]));
  assert.ok(writes.includes('directory'), 'a write must still fsync its directory');

  const reads = recordFsyncs(() => {
    ledger.snapshotReadOnly('claude');
    ledger.entries();
  });
  assert.deepEqual(reads.filter(kind => kind === 'directory'), []);
});

test('an explicit durable:false lock takes no directory fsync on acquire or release', (t) => {
  const dir = scratch(t);
  const lock = join(dir, 'owner.lock');

  const durable = recordFsyncs(() => acquireProcessLockSync(lock)());
  assert.ok(durable.includes('directory'), 'the default lock keeps its durability barrier');

  const relaxed = recordFsyncs(() => acquireProcessLockSync(lock, { durable: false })());
  assert.deepEqual(relaxed.filter(kind => kind === 'directory'), []);
});
