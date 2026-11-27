import './helpers/no-browser.mjs';
// Known-bad control for the Node gate: a file whose tests are all skipped or todo must not pass.
// Before the fix, runJob reported these files with no reasons (a green tier with nothing executed).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runJob } from '../scripts/run-tests.mjs';

function fixture(source) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-false-green-runner-'));
  writeFileSync(join(dir, 'fixture.test.mjs'), ["import test from 'node:test';", source].join('\n'));
  return runJob({ kind: 'node', name: 'fixture.test.mjs', cwd: dir, args: ['--test', '--test-reporter=tap', 'fixture.test.mjs'] },
    { dir, fileTimeoutMs: 20000 });
}

test('a file whose only test is skipped fails the gate instead of passing with nothing executed', async () => {
  const result = await fixture("test.skip('skipped', () => {});");
  assert.equal(result.summary.pass, 0);
  assert.equal(result.summary.skipped, 1);
  assert.deepEqual(result.reasons, ['no test passed (1 skipped, 0 todo)']);
});

test('a file whose only test is todo fails the gate instead of passing with nothing executed', async () => {
  const result = await fixture("test.todo('todo', () => {});");
  assert.equal(result.summary.pass, 0);
  assert.equal(result.summary.todo, 1);
  assert.deepEqual(result.reasons, ['no test passed (0 skipped, 1 todo)']);
});

test('a file with one passing test and one skipped test still passes, and the skip is counted', async () => {
  const result = await fixture("test('runs', () => {});\ntest.skip('skipped', () => {});");
  assert.equal(result.summary.pass, 1);
  assert.equal(result.summary.skipped, 1);
  assert.deepEqual(result.reasons, []);
});
