import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createLendingActivity, ACTIVITY_BIN_MS } from '../lib/v1/lending-activity.mjs';
import { evaluateLending } from '../lib/v1/lending-policy.mjs';

const MIN = 60000, HOUR = 60 * MIN, WEEK = 7 * 24 * HOUR;
const START = Date.parse('2026-10-05T22:00:00Z'), NOW = START + 2 * WEEK;
mkdirSync(join(homedir(), '.tmp'), { recursive: true });
function withDir(fn) {
  const dir = mkdtempSync(join(homedir(), '.tmp', 'lending-activity-test-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
// History is seeded as the file observe() writes, so long fixtures cost one write. `value(t)` is 1, 0 or undefined (unobserved).
function seed(file, from, ms, value) {
  const bins = [];
  for (let t = from; t < from + ms; t += ACTIVITY_BIN_MS) { const v = value(t); if (v !== undefined) bins.push([Math.floor(t / ACTIVITY_BIN_MS), v]); }
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema_version: 1, bins }));
}
const at = (file, t) => createLendingActivity({ file, now: () => t });

test('two full weeks away in the next 5 h of the week make a new block eligible; legacy activity fields are rejected by the engine', () => withDir(dir => {
  const file = join(dir, 'a.json');
  seed(file, START, 2 * WEEK, () => 0);
  const f = at(file, NOW).forecast();
  assert.deepEqual(f, { weeks: 2, futureActiveFraction: 0, eligible: true });
  assert.throws(() => evaluateLending({policy: {hourlyRatePct: 100}, activity: f,
    windows: [{window_id: 'five_hour', window_minutes: 300, state: 'not_open', used_pct: 0,
      resets_at: null, observed_at: NOW - MIN, kappa: 1}]}), /invalid_lending_policy/,
  'the retired activity allocator cannot bypass the normalized objective engine');
}));

test('any active bin makes that week active; the fraction counts weeks; activity after the period does not count', () => withDir(dir => {
  const file = join(dir, 'a.json');
  // The older week has one 5-minute active spell 3 h into the forecast period; the newer week is away throughout.
  seed(file, START, 2 * WEEK, t => t === START + 3 * HOUR ? 1 : 0);
  assert.deepEqual(at(file, NOW).forecast(), { weeks: 2, futureActiveFraction: 0.5, eligible: false });
  assert.deepEqual(at(file, NOW).forecast(120), { weeks: 2, futureActiveFraction: 0, eligible: true }, 'a 2 h period ends before the spell');
  seed(file, START, 2 * WEEK, t => t === START + 6 * HOUR ? 1 : 0);
  assert.equal(at(file, NOW).forecast().futureActiveFraction, 0);
}));

test('missing observations are not "away": thin, gappy or unknown history is not eligible', () => withDir(dir => {
  const file = join(dir, 'a.json'), hole = START + WEEK + HOUR;
  seed(file, START + WEEK, WEEK, () => 0);
  assert.deepEqual(at(file, NOW).forecast(), { weeks: 1, futureActiveFraction: 1, eligible: false });
  // A 1 h hole in the newer week's 5 h period leaves 80% coverage (< 90%): that week does not count.
  seed(file, START, 2 * WEEK, t => t >= hole && t < hole + HOUR ? undefined : 0);
  assert.deepEqual(at(file, NOW).forecast(), { weeks: 1, futureActiveFraction: 1, eligible: false });
  // 25 min missing of 300 (91.7% coverage) still counts.
  seed(file, START, 2 * WEEK, t => t >= hole && t < hole + 25 * MIN ? undefined : 0);
  assert.equal(at(file, NOW).forecast().weeks, 2);
  // Unknown (null) readings record nothing.
  const fresh = join(dir, 'fresh.json'), a = at(fresh, NOW);
  assert.equal(a.observe(null), false); assert.equal(a.observe(undefined), false); assert.equal(a.writes(), 0);
  assert.deepEqual(a.forecast(), { weeks: 0, futureActiveFraction: 1, eligible: false });
}));

test('observe: active wins in a bin; writes throttled to one per bin plus an away-to-active change; 0600 times+booleans only', () => withDir(dir => {
  const file = join(dir, 'state', 'activity.json');
  let t = NOW;
  const a = createLendingActivity({ file, now: () => t });
  assert.equal(a.observe(false), true); assert.equal(a.writes(), 1);
  for (let i = 0; i < 20; i++) { t += 1000; a.observe(false); }
  assert.equal(a.writes(), 1);
  assert.equal(a.observe(true), true); assert.equal(a.writes(), 2);
  a.observe(false); a.observe(true);
  assert.equal(a.writes(), 2, 'a bin that was active stays active');
  t += ACTIVITY_BIN_MS; a.observe(false);
  assert.equal(a.writes(), 3);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(file, 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['bins', 'schema_version']);
  assert.deepEqual(stored.bins.map(r => r[1]), [1, 0]);
  for (const row of stored.bins) { assert.equal(row.length, 2); assert.ok(Number.isSafeInteger(row[0])); }
}));

test('history survives a restart and new observations append to it', () => withDir(dir => {
  const file = join(dir, 'a.json');
  seed(file, START, 2 * WEEK, () => 0);
  let t = NOW;
  const a = createLendingActivity({ file, now: () => t });
  a.observe(true);
  // A new process sees both the seeded weeks and the new active bin.
  const restarted = at(file, NOW);
  assert.equal(restarted.forecast().eligible, true);
  assert.equal(at(file, NOW + WEEK - 3 * HOUR).forecast().futureActiveFraction > 0, true, 'last week\'s active bin is in the next 5 h');
}));

test('retains 8 weeks; future evidence is ignored and pruned; corruption is unknown history', () => withDir(dir => {
  const file = join(dir, 'a.json');
  seed(file, START - 8 * WEEK, 10 * WEEK, () => 0);
  assert.equal(at(file, NOW).forecast().weeks, 8);
  const a = at(file, NOW);
  a.observe(false);
  const stored = JSON.parse(readFileSync(file, 'utf8')).bins;
  assert.ok(stored.length <= 8 * WEEK / ACTIVITY_BIN_MS, String(stored.length));
  // A clock moved back one week: bins after "now" never count, and are dropped on the next write.
  seed(file, START, 2 * WEEK, t => t >= START + WEEK ? 1 : 0);
  const back = at(file, START + WEEK);
  assert.deepEqual(back.forecast(), { weeks: 1, futureActiveFraction: 1, eligible: false });
  const earlier = at(file, START + WEEK - ACTIVITY_BIN_MS);
  assert.equal(earlier.observe(true), true, 'an away bin turning active is written');
  const kept = JSON.parse(readFileSync(file, 'utf8')).bins;
  assert.ok(kept.every(r => r[0] <= Math.floor((START + WEEK - ACTIVITY_BIN_MS) / ACTIVITY_BIN_MS)));
  assert.ok(kept.length > 0);
  // Corrupt or malformed files read as no history and are replaced on the next write.
  writeFileSync(file, '{oops');
  const corrupt = at(file, NOW);
  assert.deepEqual(corrupt.forecast(), { weeks: 0, futureActiveFraction: 1, eligible: false });
  corrupt.observe(false);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).schema_version, 1);
  writeFileSync(file, JSON.stringify({ schema_version: 1, bins: [[1, 7], ['x', 1]] }));
  assert.equal(at(file, NOW).forecast().weeks, 0);
  assert.deepEqual(at(file, NaN).forecast(), { weeks: 0, futureActiveFraction: 1, eligible: false });
}));

test('the module reads no host session logs or credentials', () => {
  const src = readFileSync(new URL('../lib/v1/lending-activity.mjs', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
  assert.doesNotMatch(src, /(^|[^A-Za-z0-9_])\.(claude|codex)(?![A-Za-z0-9_])|credentials|homedir|process\.env|sessions/);
});
