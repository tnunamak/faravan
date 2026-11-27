import './helpers/no-browser.mjs';
// Known-bad controls for the macOS graceful-shutdown check. The smoke itself runs only on macOS, so the decision is a
// pure function (scripts/macos-graceful-shutdown.mjs) tested here, and a source check confirms the smoke calls it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gracefulShutdownProblems } from '../scripts/macos-graceful-shutdown.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('a bundle that removes its record and exits 42 on SIGTERM fails the graceful shutdown and names the exit', () => {
  const problems = gracefulShutdownProblems({ exitCode: 42, exitSignal: null, recordRemoved: true });
  assert.deepEqual(problems, ['exited with code 42']);
});

test('an exit by signal is not a graceful shutdown', () => {
  assert.deepEqual(gracefulShutdownProblems({ exitCode: null, exitSignal: 'SIGKILL', recordRemoved: true }), ['exited by signal SIGKILL']);
});

test('a clean exit 0 that leaves the discovery record behind is not a graceful shutdown', () => {
  assert.deepEqual(gracefulShutdownProblems({ exitCode: 0, exitSignal: null, recordRemoved: false }),
    ['discovery record app.json was not removed']);
});

test('exit 0 with the record removed is a graceful shutdown', () => {
  assert.deepEqual(gracefulShutdownProblems({ exitCode: 0, exitSignal: null, recordRemoved: true }), []);
});

test('the macOS smoke judges the exit through the policy instead of awaiting the exit and ignoring it', () => {
  const source = readFileSync(join(REPO, 'scripts', 'verify-macos-install.mjs'), 'utf8');
  assert.match(source, /const \[exitCode,exitSignal\]=await Promise\.race/);
  assert.match(source, /gracefulShutdownProblems\(\{exitCode,exitSignal,recordRemoved\}\)/);
});
