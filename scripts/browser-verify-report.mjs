#!/usr/bin/env node
// Prints the V1 lane as a table (slices x checks) from test-artifacts/browser-verify/results.json,
// then the reason for every failure. pass / FAIL / expected-fail (named) / n/a.
// `--release`: also exit 1 unless the report proves a complete, first-attempt run (browser-verify-lib.mjs).
import { readFileSync } from 'node:fs';
import { RESULTS_FILE, isExpectedFailure, releaseProblems } from './browser-verify-lib.mjs';

const file = RESULTS_FILE;
const args = process.argv.slice(2);
const release = args.includes('--release');
const seconds = args.find(arg => /^\d+$/.test(arg));
let report;
try { report = JSON.parse(readFileSync(file, 'utf8')); } catch { console.error('no results at ' + file); process.exit(1); }
if (!Array.isArray(report?.suites)) { console.error('no results at ' + file + ': not a Playwright JSON report'); process.exit(1); }

const cells = new Map(), slices = [], checks = [];
const walk = suite => {
  for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
    const a = type => test.annotations.filter(x => x.type === type).map(x => x.description);
    const [slice] = a('slice'), [check] = a('check');
    if (!slice) continue;
    if (!slices.includes(slice)) slices.push(slice);
    if (!checks.includes(check)) checks.push(check);
    const result = test.results.at(-1), skipped = test.status === 'skipped';
    const known = a('known')[0];
    const note = a('reason')[0] ?? result?.error?.message?.split('\n')[0] ?? '';
    let cell;
    if (skipped) cell = {mark: 'n/a'};
    else if (isExpectedFailure(test) && known) cell = {mark: 'exp:' + known, note, shots: a('screenshot')};
    // Expected to fail with no named reason: the product assertion failed, so this is not a pass.
    else if (isExpectedFailure(test)) cell = {mark: 'FAIL', note: 'expected failure without a known annotation (name the reason with a known annotation)', shots: a('screenshot')};
    else if (test.status === 'expected' && known) cell = {mark: 'exp:' + known, note, shots: a('screenshot')};
    else if (test.status === 'expected') cell = {mark: 'pass'};
    else cell = {mark: !note.includes('NEW:') && note.includes('FIXED?') ? 'FIXED?' : 'FAIL', note, shots: a('screenshot')};
    // Every attempt stays on the cell: a retried test is never shown as its last attempt alone.
    cell.attempts = test.results.map(attempt => ({status: attempt.status, error: attempt.error?.message?.split('\n')[0]}));
    cells.set(slice + '|' + check, cell);
  }
  for (const child of suite.suites ?? []) walk(child);
};
for (const suite of report.suites) walk(suite);

const width = Math.max(...checks.map(c => c.length), 12) + 1;
console.log('\nV1 browser verification lane');
console.log(['slice'.padEnd(6), ...checks.map(c => c.padEnd(width))].join(' '));
for (const slice of slices) console.log([slice.padEnd(6), ...checks.map(c => (cells.get(slice + '|' + c)?.mark ?? '-').padEnd(width))].join(' '));
const bad = [...cells].filter(([, v]) => ['FAIL', 'FIXED?'].includes(v.mark) || v.mark.startsWith('exp:'));
if (bad.length) console.log('\nDetails');
for (const [key, v] of bad) {
  console.log(` ${v.mark.padEnd(8)} ${key.replace('|', ' / ')}: ${v.note ?? ''}${v.shots?.length ? '  [' + v.shots.join(', ') + ']' : ''}`);
  if (v.attempts?.length > 1) v.attempts.forEach((a, i) => console.log(`          attempt ${i + 1}: ${a.status}${a.error ? ' - ' + a.error : ''}`));
}
const counts = {};
for (const v of cells.values()) { const k = v.mark.startsWith('exp:') ? 'expected-fail' : v.mark; counts[k] = (counts[k] ?? 0) + 1; }
console.log('\n' + Object.entries(counts).map(([k, n]) => n + ' ' + k).join(', ') + (seconds ? ' · ' + seconds + ' s' : ''));
if (release) {
  const problems = releaseProblems(report);
  if (problems.length) console.log('\nRelease gate FAILED:\n' + problems.map(p => ' - ' + p).join('\n'));
  else console.log('\nRelease gate: every test ran once, none skipped');
  process.exitCode = problems.length ? 1 : 0;
}
