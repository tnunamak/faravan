// Fixture for tests/shm-cleanup.test.mjs. Run with plain `node`, not as a suite (the runner does not discover it: it sits in helpers/).
// It allocates one temporary directory, the way suites do, then ends in the failure mode named by SHM_FIXTURE_MODE:
//   success | fail (assertion) | throw (error after allocation) | timeout (node:test timeout) | sigterm (waits to be signalled).
// SHM_FIXTURE_HELPER=owned uses ownTempDir(t, …), =plain uses tempDir(…). The directory goes to stdout as `FIXTURE_DIR <path>`,
// and to SHM_FIXTURE_MARKER once it exists, so the guard signals this process only after the allocation.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
import { ownTempDir, tempDir } from './temp-dir.mjs';

const mode = process.env.SHM_FIXTURE_MODE ?? 'success';
const helper = process.env.SHM_FIXTURE_HELPER ?? 'owned';
const marker = process.env.SHM_FIXTURE_MARKER;
let allocated = null;

// Runs once the test (and its t.after hooks) has finished, while this process is still alive and before the process-exit
// fallback runs. Only per-test teardown can have removed the directory by now.
after(() => { if (allocated) process.stdout.write(`AFTER_TEST_EXISTS ${existsSync(allocated)}\n`); });

test('allocates one temporary directory, then fails as the mode says', { timeout: mode === 'timeout' ? 500 : 60000 }, async (t) => {
  const dir = helper === 'owned' ? ownTempDir(t, 'shm-fixture-') : tempDir('shm-fixture-');
  allocated = dir;
  // An unrelated entry that shares the directory's name as a prefix. Teardown must leave it alone.
  if (process.env.SHM_FIXTURE_SIBLING) writeFileSync(`${dir}.profile-write.lock-backup`, 'not ours');
  process.stdout.write(`FIXTURE_DIR ${dir}\n`);
  if (marker) writeFileSync(marker, dir);
  if (mode === 'fail') assert.fail('forced failure');
  if (mode === 'throw') throw new Error('injected after allocation');
  // The loop keeps the process alive until the signal; the timeout mode ends by the test's own timer instead.
  if (mode === 'sigterm') setInterval(() => {}, 1000);
  if (mode === 'timeout' || mode === 'sigterm') await new Promise(() => {});
});
