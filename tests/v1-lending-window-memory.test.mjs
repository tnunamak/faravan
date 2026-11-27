import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createWindowMemory} from '../lib/v1/lending-window-memory.mjs';

const H = 3_600_000;
const win = (id, durationH) => ({id, duration_ms: durationH * H});
const both = [win('seven_day', 168), win('five_hour', 5)];
const weekOnly = [win('seven_day', 168)];

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.tmp', 'wm-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const file = path.join(dir, 'lending-window-memory.json');
  const removed = [];
  const memory = createWindowMemory({file, onRemoved: e => removed.push(e)});
  return {file, memory, removed};
}

test('the first reply for an account is trusted and its windows are remembered', (t) => {
  const {memory, file} = fixture(t);
  assert.deepEqual(memory.check('claude', weekOnly, 1000 * H), {ok: true});
  assert.ok(fs.existsSync(file));
  // The remembered set is now one window; a reply with a new window adds it.
  assert.deepEqual(memory.check('claude', both, 1001 * H), {ok: true});
  assert.equal(memory.check('claude', weekOnly, 1002 * H).refuse, 'lending_window_missing');
});

test('a later reply that lacks a remembered window refuses and names it', (t) => {
  const {memory} = fixture(t);
  memory.check('claude', both, 1000 * H);
  const r = memory.check('claude', weekOnly, 1001 * H);
  assert.equal(r.refuse, 'lending_window_missing');
  assert.deepEqual(r.missing, ['five_hour']);
});

test('windows are remembered per provider', (t) => {
  const {memory} = fixture(t);
  memory.check('claude', both, 1000 * H);
  assert.deepEqual(memory.check('codex', weekOnly, 1001 * H), {ok: true});
});

test('read-only status checks never advance or retire a missing window', (t) => {
  const {memory, file, removed} = fixture(t);
  memory.check('claude', both, 1000 * H);
  memory.check('claude', weekOnly, 1001 * H);
  const before = fs.readFileSync(file, 'utf8');
  assert.equal(memory.check('claude', weekOnly, 1007 * H, {readOnly: true}).refuse, 'lending_window_missing');
  assert.equal(fs.readFileSync(file, 'utf8'), before);
  assert.deepEqual(removed, []);
  assert.deepEqual(memory.check('claude', weekOnly, 1007 * H), {ok: true});
  assert.equal(removed.length, 1);
});

test('a window is accepted as gone only after its own duration of replies without it, and the removal is logged', (t) => {
  const {memory, removed} = fixture(t);
  memory.check('claude', both, 1000 * H);
  assert.equal(memory.check('claude', weekOnly, 1001 * H).refuse, 'lending_window_missing'); // clock starts
  assert.equal(memory.check('claude', weekOnly, 1001 * H + 4.9 * H).refuse, 'lending_window_missing');
  assert.deepEqual(removed, []);
  assert.deepEqual(memory.check('claude', weekOnly, 1001 * H + 5 * H), {ok: true});
  assert.deepEqual(removed, [{provider: 'claude', window_id: 'five_hour', absent_for_ms: 5 * H}]);
  assert.deepEqual(memory.check('claude', weekOnly, 1010 * H), {ok: true});
  assert.equal(removed.length, 1);
});

test('a reply that includes the window again resets its absence clock', (t) => {
  const {memory, removed} = fixture(t);
  memory.check('claude', both, 1000 * H);
  memory.check('claude', weekOnly, 1001 * H);
  assert.deepEqual(memory.check('claude', both, 1004 * H), {ok: true});
  assert.equal(memory.check('claude', weekOnly, 1005 * H).refuse, 'lending_window_missing');
  // 5h after the FIRST gap would be 1006h, but the clock restarted at 1005h.
  assert.equal(memory.check('claude', weekOnly, 1006 * H).refuse, 'lending_window_missing');
  assert.deepEqual(memory.check('claude', weekOnly, 1010 * H), {ok: true});
  assert.equal(removed.length, 1);
});

test('an unreadable memory file refuses and is never overwritten', (t) => {
  const {memory, file} = fixture(t);
  fs.writeFileSync(file, '{not json');
  assert.equal(memory.check('claude', both, 1000 * H).refuse, 'lending_window_memory_unreadable');
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json');
  fs.writeFileSync(file, JSON.stringify({schema_version: 99}));
  assert.equal(memory.check('claude', both, 1000 * H).refuse, 'lending_window_memory_unreadable');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify({schema_version: 99}));
});

test('a directory where the file should be is unreadable, not empty', (t) => {
  const {memory, file} = fixture(t);
  fs.mkdirSync(file);
  assert.equal(memory.check('claude', both, 1000 * H).refuse, 'lending_window_memory_unreadable');
});

test('an account that used to report a five-hour window and now does not is refused until a full five-hour window passes, then accepted and logged', (t) => {
  const {memory, removed} = fixture(t);
  const fiveHour = both.find(w => w.id === 'five_hour');
  const t0 = 2000 * H;
  assert.deepEqual(memory.check('claude', both, t0), {ok: true}); // used to report it
  const gap = t0 + H; // first reply without it
  const refused = memory.check('claude', weekOnly, gap);
  assert.equal(refused.refuse, 'lending_window_missing');
  assert.deepEqual(refused.missing, ['five_hour']);
  // Consistent replies without it, one hour apart, stay refused until the full window length has passed.
  for (let step = 1; gap + step * H < gap + fiveHour.duration_ms; step += 1) {
    assert.equal(memory.check('claude', weekOnly, gap + step * H).refuse, 'lending_window_missing');
  }
  assert.deepEqual(removed, []);
  assert.deepEqual(memory.check('claude', weekOnly, gap + fiveHour.duration_ms), {ok: true});
  assert.deepEqual(removed, [{provider: 'claude', window_id: 'five_hour', absent_for_ms: fiveHour.duration_ms}]);
});

test('invalid durations refuse without changing memory or poisoning the next reply', (t) => {
  const {memory, file} = fixture(t);
  assert.deepEqual(memory.check('claude', both, 1000 * H), {ok: true});
  const before = fs.readFileSync(file);
  for (const duration_ms of [0, -1, NaN, Infinity, undefined]) {
    assert.equal(memory.check('claude', [both[0], {id: 'bad', duration_ms}], 1001 * H).refuse, 'lending_window_invalid');
    assert.deepEqual(fs.readFileSync(file), before);
    assert.deepEqual(memory.check('claude', both, 1002 * H), {ok: true});
  }
});
