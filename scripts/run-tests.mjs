#!/usr/bin/env node
// One command for the whole Node and shell suite: `npm test`.
//
// - One `node --test` process per test file, N files at a time. Node's own
//   --test-concurrency has no per-file watchdog, so one hung file stalls the run.
// - Each file has a watchdog. On timeout its whole process group is killed and
//   the file fails by name.
// - A file passes only if it exits 0, runs at least one test, and reports no
//   failed or cancelled tests. A file whose tests are all skipped or todo passed nothing, so it fails.
//   Skipped and todo counts are printed, so a partly skipped file shows what it did not run.
// - A file that prints nothing for STALL_MS is stuck (each test has its own timeout) and is killed.
// - A child process that outlives its file is reported as a leak and killed.
// - Output is one line per file. Failing files print the tail of their output, within a budget.
//   Full per-file logs are kept in test-artifacts/node-tests (git-ignored).
// - Exits 1 on any failure.
//
// Flags: --fast | --slow (tiers, see SLOW_FILES), --concurrency=N, --file-timeout-ms=N.
// Env: TEST_CONCURRENCY, TEST_FILE_TIMEOUT_MS, TEST_STALL_MS. Why these defaults: docs/testing.md.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLI_NAMES } from './test-cli-guard.mjs';
import { initializeFixtureHome, removeFixtureHome } from '../tests/helpers/test-home-directory.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = join(ROOT, 'tests');
const CLI_GUARD = join(ROOT, 'scripts', 'test-cli-guard.mjs');
export function createFakeCommands(parent = tmpdir()) {
  const dir = mkdtempSync(join(parent, 'faravan-fake-cli-'));
  for (const name of CLI_NAMES) writeFileSync(join(dir, name),
    '#!/bin/sh\nprintf \'TEST_FAKE_CLI: unavailable\\n\' >&2\nexit 127\n', { mode: 0o755 });
  return dir;
}
const SHELL_SUITES = ['detect-sbx.sh', 'firewall-helper.sh'];
// Node files that take more than 10 s alone on this host (measured, docs/testing.md).
// Everything else is the fast tier, which is the edit loop: `npm run test:fast`.
export const SLOW_FILES = new Set([
  'coordinator.test.mjs', 'v1-app-changes.test.mjs', 'v1-app-progress.test.mjs', 'v1-app-running-job.test.mjs',
  'v1-app-timed-pause.test.mjs', 'v1-app.test.mjs', 'v1-apply-recovery.test.mjs', 'v1-apply.test.mjs', 'v1-cli.test.mjs', 'v1-client.test.mjs',
  'v1-job-meta.test.mjs', 'v1-leave.test.mjs', 'v1-lender.test.mjs', 'v1-ops-e2e.test.mjs', 'v1-owner-approval.test.mjs',
  'v1-petnames.test.mjs', 'v1-server.test.mjs', 'v1-short-invite.test.mjs', 'v1-store.test.mjs',
]);
const LEAK_GRACE_MS = 3000;
// Test scratch on RAM-backed storage when there is room. The stores fsync on every commit: with
// scratch on disk, v1-app ran 2.8x slower with identical results (docs/testing.md).
const SCRATCH_MIN_BYTES = 2 * 2 ** 30;
export function ramScratchRoot() {
  try {
    const fs = statfsSync('/dev/shm');
    return fs.bavail * fs.bsize >= SCRATCH_MIN_BYTES ? '/dev/shm' : null;
  } catch {
    return null;
  }
}
// Node applies --test-timeout to the file as well as to each test, so it carries the file budget (a 120 s value cancelled
// v1-app before the serial file finished). Tests that must fail sooner set their own `timeout`; a file that prints nothing for
// STALL_MS is stuck either way.
const FILE_TIMEOUT_MS = 600000;
const STALL_MS = Number(process.env.TEST_STALL_MS) || 180000;

// Node wraps a file that registers no tests in one file-level entry ("ok 1 - x.test.mjs"),
// so that entry is not a test. Counts come from TAP's summary lines. A skipped or todo test is
// registered but not passed: `pass` excludes both (verified against node 22 and 24 TAP output).
export function parseNodeSummary(output) {
  const count = (label) => {
    const matches = [...output.matchAll(new RegExp(`^# ${label} (.*)$`, 'gm'))];
    if (matches.length !== 1 || !/^\d+$/.test(matches[0][1])) return null;
    const value = Number(matches[0][1]);
    return Number.isSafeInteger(value) ? value : null;
  };
  const wrappers = (output.match(/^(?:not )?ok \d+ - \S+\.test\.mjs$/gm) ?? []).length;
  const tests = count('tests');
  return {
    tests: tests === null ? null : tests - wrappers, pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'),
    skipped: count('skipped') ?? 0, todo: count('todo') ?? 0,
  };
}

// Failure reasons for one finished job. An empty list means it passed.
export function judge(job) {
  const reasons = [];
  if (job.stalled) reasons.push(`no output for ${Math.round(job.stallMs / 1000)} s (killed; it had stopped making progress)`);
  else if (job.timedOut) reasons.push(`timed out after ${job.timeoutMs} ms`);
  else if (job.code !== 0) reasons.push(job.signal ? `killed by ${job.signal}` : `exit ${job.code}`);
  if (job.leaked) reasons.push('left child processes running after the file ended (killed)');
  if (job.kind === 'node') {
    const s = job.summary;
    if (!s || s.tests === null) reasons.push('no test summary (the harness did not finish)');
    else {
      if ([s.tests, s.pass, s.fail, s.cancelled].some(value => !Number.isSafeInteger(value) || value < 0))
        reasons.push('invalid or incomplete test summary');
      if (s.tests === 0) reasons.push('zero tests ran');
      if (s.fail) reasons.push(`${s.fail} failed`);
      if (s.cancelled) reasons.push(`${s.cancelled} cancelled (never settled)`);
      // A file whose every test is skipped or todo would otherwise pass with nothing executed.
      if (s.tests > 0 && s.pass === 0 && !s.fail && !s.cancelled) reasons.push(`no test passed (${s.skipped} skipped, ${s.todo} todo)`);
    }
  }
  return reasons;
}

export function parseArgs(argv, env = process.env) {
  const opts = {
    fast: argv.includes('--fast'),
    slow: argv.includes('--slow'),
    concurrency: Number(env.TEST_CONCURRENCY) || 4,
    fileTimeoutMs: Number(env.TEST_FILE_TIMEOUT_MS) || FILE_TIMEOUT_MS,
  };
  for (const arg of argv) {
    const concurrency = arg.match(/^--concurrency=(\d+)$/);
    if (concurrency) opts.concurrency = Number(concurrency[1]);
    const timeout = arg.match(/^--file-timeout-ms=(\d+)$/);
    if (timeout) opts.fileTimeoutMs = Number(timeout[1]);
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) throw new Error('concurrency must be a positive integer');
  if (opts.fast && opts.slow) throw new Error('use --fast or --slow, not both');
  return opts;
}

export function discover({ fast = false, slow = false, fileTimeoutMs = FILE_TIMEOUT_MS } = {}) {
  const nodeFiles = readdirSync(TESTS).filter((name) => name.endsWith('.test.mjs')).sort();
  if (nodeFiles.length === 0) throw new Error(`no *.test.mjs files in ${TESTS}`);
  const jobs = nodeFiles
    .filter((name) => (fast ? !SLOW_FILES.has(name) : slow ? SLOW_FILES.has(name) : true))
    .map((name) => ({ kind: 'node', name, args: ['--test', '--test-reporter=tap', `--test-timeout=${fileTimeoutMs}`, join('tests', name)] }));
  if (jobs.length === 0) throw new Error(`no files selected for ${fast ? 'the fast' : slow ? 'the slow' : 'the full'} tier`);
  if (!slow) for (const name of SHELL_SUITES) jobs.push({ kind: 'shell', name, command: 'bash', args: [join('tests', name)] });
  return jobs;
}

export function runJob(job, { dir, fileTimeoutMs, stallMs = STALL_MS, scratch = null, fakeDir = null, signal }) {
  return new Promise((resolve) => {
    const started = Date.now();
    // NODE_TEST_CONTEXT is set for processes spawned by a test. It makes a nested
    // `node --test` speak the child protocol and print no summary, so drop it.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    // Each file gets its own directory under the run scratch. It is removed when the file ends, also when the watchdog
    // killed the file (SIGKILL runs no handler in the file), so nothing the file left behind outlives it.
    const fileScratch = scratch ? mkdtempSync(join(scratch, 'file-')) : null;
    if (fileScratch) env.TMPDIR = env.TMP = env.TEMP = fileScratch;
    // A socket path needs a shorter parent than TMPDIR. The runner owns this second location as well.
    const shortHome = job.kind === 'node' ? mkdtempSync('/tmp/f-') : null;
    if (shortHome) {
      initializeFixtureHome(shortHome);
      env.FARAVAN_SBX_SHORT_HOME_BASE = shortHome;
      delete env.FARAVAN_TEST_HOME;
    }
    const ownedFakeDir = fakeDir ? null : createFakeCommands();
    env.TEST_CLI_FAKE_DIR = fakeDir ?? ownedFakeDir;
    env.PATH = `${env.TEST_CLI_FAKE_DIR}:${env.PATH ?? '/usr/bin:/bin'}`;
    const guardFlag = `--import=${JSON.stringify(CLI_GUARD)}`;
    if (!(env.NODE_OPTIONS ?? '').includes(CLI_GUARD)) env.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} ${guardFlag}`.trim();
    const child = spawn(job.command ?? process.execPath, job.args, { cwd: job.cwd ?? ROOT, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    job.pid = child.pid;
    let output = '', lastOutputAt = Date.now();
    child.stdout.on('data', (chunk) => { output += chunk; lastOutputAt = Date.now(); });
    child.stderr.on('data', (chunk) => { output += chunk; lastOutputAt = Date.now(); });
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} };
    let timedOut = false, stalled = false, leaked = false, exited = null, grace = null, done = false;
    const stop = () => {
      clearTimeout(watchdog);
      clearInterval(stallCheck);
      killGroup();
      grace ??= setTimeout(finish, LEAK_GRACE_MS);
    };
    const finish = (spawnError) => {
      if (done) return;
      done = true;
      clearTimeout(watchdog);
      clearInterval(stallCheck);
      clearTimeout(grace);
      signal?.removeEventListener('abort', stop);
      const cleanupPending = !exited && !spawnError;
      if (cleanupPending) {
        child.unref();
        child.stdout.destroy();
        child.stderr.destroy();
        output += `Test process did not exit after SIGKILL. Retained directories: ${[fileScratch, shortHome, ownedFakeDir].filter(Boolean).join(', ')}\n`;
      } else {
        if (ownedFakeDir) rmSync(ownedFakeDir, { recursive: true, force: true });
        if (fileScratch) rmSync(fileScratch, { recursive: true, force: true });
        if (shortHome) removeFixtureHome(shortHome);
      }
      if (spawnError) output += `spawn error: ${spawnError.message}\n`;
      const summary = job.kind === 'node' ? parseNodeSummary(output) : null;
      const logPath = join(dir, `${job.name}.log`);
      writeFileSync(logPath, output);
      const result = {
        ...job, timedOut, timeoutMs: fileTimeoutMs, stalled, stallMs, leaked, cleanupPending, summary, output, logPath,
        code: spawnError ? 1 : exited?.code ?? 1, signal: exited?.signal ?? null,
        seconds: (Date.now() - started) / 1000,
      };
      result.reasons = judge(result);
      resolve(result);
    };
    const watchdog = setTimeout(() => { timedOut = true; stop(); }, fileTimeoutMs);
    const stallCheck = setInterval(() => {
      if (Date.now() - lastOutputAt < stallMs) return;
      stalled = true; stop();
    }, Math.min(5000, Math.max(20, stallMs / 4)));
    child.on('error', (error) => finish(error));
    child.on('exit', (code, signal) => {
      exited = { code, signal };
      clearTimeout(watchdog);
      clearInterval(stallCheck);
      // A grandchild that survived its file (a leaked server or daemon) keeps the group alive.
      try { process.kill(-child.pid, 0); leaked = true; killGroup(); } catch {}
      // Output may still be open through a leaked grandchild; do not wait forever for it.
      grace ??= setTimeout(finish, LEAK_GRACE_MS);
    });
    child.on('close', () => finish());
    signal?.addEventListener('abort', stop, {once:true});
    if (signal?.aborted) stop();
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const jobs = discover(opts);
  // Per-file logs live in the repo (git-ignored), not in $TMPDIR: a sandbox may delete $TMPDIR when it exits.
  const dir = join(ROOT, 'test-artifacts', 'node-tests');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const root = ramScratchRoot();
  const scratch = root ? mkdtempSync(join(root, 'faravan-tests-')) : null;
  let cleanupPending = false;
  if (scratch) process.on('exit', () => {
    if (!cleanupPending) rmSync(scratch, { recursive: true, force: true });
  });
  const fakeDir = createFakeCommands();
  const cleanupFakes = () => {
    if (!cleanupPending) rmSync(fakeDir, { recursive: true, force: true });
  };
  process.once('exit', cleanupFakes);
  const interrupted = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => interrupted.abort());

  const results = [];
  const queue = [...jobs];
  const started = Date.now();
  async function worker() {
    while (queue.length && !interrupted.signal.aborted) {
      const job = queue.shift();
      const result = await runJob(job, { dir, fileTimeoutMs: opts.fileTimeoutMs, scratch, fakeDir, signal:interrupted.signal });
      cleanupPending ||= result.cleanupPending;
      results.push(result);
      const status = result.reasons.length ? 'FAIL' : 'ok  ';
      const skips = result.summary?.skipped ? `, ${result.summary.skipped} skipped` : '';
      const count = result.summary?.tests != null ? ` (${result.summary.tests} tests${skips})` : '';
      const why = result.reasons.length ? `: ${result.reasons.join('; ')}` : '';
      console.log(`${status} ${result.name}${count} ${result.seconds.toFixed(1)}s${why}`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, jobs.length) }, worker));

  // The checker caps output at 512 KB: keep the tail of each failing file, within a total budget.
  const failed = results.filter((r) => r.reasons.length);
  let budget = 240000;
  for (const result of failed) {
    const tail = result.output.slice(-Math.min(24000, Math.max(0, budget)));
    budget -= tail.length;
    console.log(`\n==== ${result.name}: ${result.reasons.join('; ')}\n${tail}`);
  }
  const tests = results.reduce((sum, r) => sum + (r.summary?.tests ?? 0), 0);
  const skipped = results.reduce((sum, r) => sum + (r.summary?.skipped ?? 0), 0);
  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  cleanupFakes();
  process.removeListener('exit', cleanupFakes);
  console.log(`\n${results.length - failed.length}/${results.length} files passed, ${tests} tests (${skipped} skipped), ${seconds}s, concurrency ${opts.concurrency}, scratch ${scratch ? 'in RAM' : 'on disk ' + tmpdir()}`);
  if (failed.length) console.log(`per-file logs: ${dir}`);
  process.exitCode = interrupted.signal.aborted ? 130 : failed.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
