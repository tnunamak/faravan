import './helpers/no-browser.mjs';
// Temporary directories do not outlive their suite. Each check runs a child process whose TMPDIR is a unique root that this
// test made. The child must allocate inside that root. After the child has exited, the root and the entries named after it
// must be empty, and only then does this test remove its container. The root sits inside a container this test made, so other
// processes' directories are never counted, and nothing is removed by prefix. Owned-mode checks also look while the child is
// alive, after its test ended, so a missing t.after cannot hide behind the process-exit fallback.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runJob } from '../scripts/run-tests.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = 'tests/helpers/shm-owned-fixture.test.mjs';
// RAM-backed when present: the leaks this guards against landed in /dev/shm.
const BASE = existsSync('/dev/shm') ? '/dev/shm' : tmpdir();
const ENV = {
  FARAVAN_NO_BROWSER: '1', DISPLAY: '', WAYLAND_DISPLAY: '', FARAVAN_NO_AUTOSTART: '1',
};

/** Entries under `root`. Every directory and lock entry a check makes lands here. */
const leftovers = (root) => readdirSync(root);

/**
 * Run `check(root, markerPath)` with a fresh root inside a container this call made. Only the container is removed, never
 * anything matched by prefix. `${container}.notes` stands in for an unrelated sibling that shares the container's prefix:
 * it must survive the container's cleanup, and the call removes it itself.
 */
async function withRoot(check) {
  const container = mkdtempSync(join(BASE, 'shm-guard-'));
  const root = join(container, 'root');
  mkdirSync(root);
  const unrelated = `${container}.notes`;
  writeFileSync(unrelated, 'not ours');
  try {
    try {
      await check(root, join(container, 'marker'));
      // Entries beside the root (`root.profile-write.lock`, ...) are leaks too. Only the harness's own entries may be here.
      const unexpected = readdirSync(container).filter((entry) => entry !== 'root' && entry !== 'marker');
      assert.deepEqual(unexpected, [], 'entries were left beside the root');
    } finally {
      rmSync(container, { recursive: true, force: true });
    }
    assert.equal(readFileSync(unrelated, 'utf8'), 'not ours', 'an unrelated sibling sharing the prefix must survive the cleanup');
  } finally {
    rmSync(unrelated, { force: true });
  }
}

const childEnv = (root) => {
  const env = { ...process.env, ...ENV, TMPDIR: root, TMP: root, TEMP: root, TEST_TMPDIR: root };
  // A test process sets NODE_TEST_CONTEXT for its children; a nested `node --test` then prints no summary.
  delete env.NODE_TEST_CONTEXT;
  return env;
};

/** The fixture in one failure mode, run with plain node. Returns its exit status and the directory it allocated. */
async function runFixture(root, marker, { mode, helper }) {
  const child = spawn(process.execPath, [FIXTURE], { cwd: ROOT, env: { ...childEnv(root), SHM_FIXTURE_MODE: mode, SHM_FIXTURE_HELPER: helper, SHM_FIXTURE_MARKER: marker, SHM_FIXTURE_SIBLING: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const closed = once(child, 'close'); // after stdio ends, so all output is read
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stdout += chunk; });
  if (mode === 'sigterm') {
    // Signal only after the allocation, so the directory exists when the signal arrives.
    const deadline = Date.now() + 60000;
    while (!existsSync(marker) && child.exitCode === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill('SIGTERM');
  }
  const [code, signal] = await closed;
  const match = /FIXTURE_DIR (\S+)/.exec(stdout);
  return { code, signal, dir: match?.[1] ?? null, afterTest: /AFTER_TEST_EXISTS (true|false)/.exec(stdout)?.[1] ?? null, stdout };
}

for (const helper of ['owned', 'plain']) {
  for (const mode of ['success', 'fail', 'throw', 'timeout', 'sigterm']) {
    test(`${helper} temp directory, ${mode}: allocated in the root and gone before the parent cleans up`, { timeout: 120000 }, async () => {
      await withRoot(async (root, marker) => {
        const run = await runFixture(root, marker, { mode, helper });
        assert.ok(run.dir, `the fixture did not report its directory:\n${run.stdout}`);
        assert.equal(dirname(run.dir), root, 'the directory must be allocated inside the root the guard assigned');
        if (mode === 'success') assert.equal(run.code, 0, run.stdout);
        else if (mode === 'sigterm') assert.equal(run.signal, 'SIGTERM', 'the signal must still terminate the process');
        else assert.notEqual(run.code, 0, `${mode} should fail:\n${run.stdout}`);
        // The unrelated sibling the fixture wrote must survive teardown; everything else must be gone.
        assert.deepEqual(leftovers(root), [`${basename(run.dir)}.profile-write.lock-backup`], `${mode}: temporary entries left behind, or the unrelated sibling was removed`);
        // Per-test teardown, not the process-exit fallback: the fixture looked while it was still alive, after its test ended.
        if (helper === 'owned' && mode !== 'sigterm') assert.equal(run.afterTest, 'false', `${mode}: the directory outlived its test (the t.after removal is missing)`);
      });
    });
  }
}

// Passing runs of the suites that create directories. One per creator: telemetry-offline (tel-offline-, the simulateOutage
// pair), telemetry-epochs (tel-epoch-), telemetry-crash (tel-test-, the harness), v1-circle-profile (lock sidecars beside homes),
// v1-lending-persisted-holds (persisted-hold-), v1-lending-native-meter-session (native-meter-journal-), v1-lender-pace50-provider-roster
// (real-provider-roster-).
const SUITES = [
  'tests/telemetry-offline.test.mjs', 'tests/telemetry-epochs.test.mjs', 'tests/telemetry-crash.test.mjs', 'tests/v1-circle-profile.test.mjs',
  'tests/v1-lending-persisted-holds.test.mjs', 'tests/v1-lending-native-meter-session.test.mjs', 'tests/v1-lender-pace50-provider-roster.test.mjs',
];
for (const file of SUITES) {
  test(`a passing run of ${basename(file)} leaves no temporary directory behind`, { timeout: 330000 }, async () => {
    await withRoot(async (root) => {
      const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: ROOT, env: childEnv(root), encoding: 'utf8', timeout: 300000 });
      assert.equal(run.status, 0, `${file} failed:\n${run.stdout.slice(-2000)}`);
      assert.deepEqual(leftovers(root), [], `${file} left temporary entries behind`);
    });
  });
}

test('a file killed by the runner watchdog leaves nothing in the run scratch', async () => {
  await withRoot(async (scratch, ack) => {
    const dir = mkdtempSync(join(BASE, 'shm-guard-logs-'));
    try {
      // The child writes into its TMPDIR, then records what it sees there to `ack`, then waits for the watchdog. A watchdog that
      // fires before the child started leaves no ack, and the check fails instead of passing on an empty scratch.
      const script = "const fs = require('node:fs'), { join } = require('node:path');"
        + "fs.writeFileSync(join(process.env.TMPDIR, 'leftover'), 'x');"
        + `fs.writeFileSync(${JSON.stringify(ack)}, JSON.stringify(fs.readdirSync(process.env.TMPDIR)));`
        + 'setTimeout(() => {}, 60000);';
      const job = { kind: 'shell', name: 'killed-by-watchdog', command: process.execPath, cwd: ROOT, args: ['-e', script] };
      const result = await runJob(job, { dir, fileTimeoutMs: 8000, scratch });
      assert.equal(result.timedOut, true, 'the watchdog must fire for this check to mean anything');
      assert.ok(existsSync(ack), 'the child never acknowledged its write before the watchdog fired: the check proved nothing');
      assert.deepEqual(JSON.parse(readFileSync(ack, 'utf8')), ['leftover'], 'the child must have had a file in its scratch before the kill');
      assert.deepEqual(leftovers(scratch), [], 'a killed file left entries in the run scratch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
