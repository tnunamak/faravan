import './helpers/no-browser.mjs';
// Known-bad controls for the browser gates. Playwright is replaced by stub executables (sh for npx/npm, a
// node stub for the two-computer cli), so no browser, network or real install runs here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const passed = (title = 'opens the lane') => ({
  title, annotations: [{ type: 'slice', description: 'S1' }, { type: 'check', description: 'loads' }],
  tests: [{ annotations: [{ type: 'slice', description: 'S1' }, { type: 'check', description: 'loads' }], status: 'expected', results: [{ status: 'passed' }] }],
});
const GOOD = { suites: [{ title: 'lane', specs: [passed()] }] };
const EMPTY = { suites: [] };

function writeStub(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// A browser-verify run: the real wrapper and report scripts (linked into a temp cwd), with stub npm and npx on PATH.
function browserLane({ report, playwrightExit = 0 }) {
  const root = mkdtempSync(join(tmpdir(), 'gate-false-green-browser-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'ui', 'node_modules', 'esbuild'), { recursive: true });
  symlinkSync(join(REPO, 'scripts'), join(root, 'scripts'), 'dir');
  const log = join(root, 'calls.log');
  const reportPath = join(root, 'report.json');
  if (report !== undefined) writeFileSync(reportPath, typeof report === 'string' ? report : JSON.stringify(report));
  writeStub(join(bin, 'npm'), `echo "npm $*" >> "${log}"\nexit 0`);
  const copy = report === undefined ? '' : `mkdir -p test-artifacts/browser-verify && cp "${reportPath}" test-artifacts/browser-verify/results.json\n`;
  writeStub(join(bin, 'npx'), `echo "npx $*" >> "${log}"\n${copy}exit ${playwrightExit}`);
  return { root, log, run: (args) => spawnSync(process.execPath, [join(REPO, 'scripts', 'browser-verify.mjs'), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } }) };
}

// A two-computer run: the real wrapper with a stub Playwright cli and stub npm. The stub copies `report` to each
// file's JSON output path when `write` is set; otherwise it writes nothing and any existing file is what the gate sees.
function twoComputerLane({ report, write = true, staleReport } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gate-false-green-two-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const cli = join(root, 'node_modules', '@playwright', 'test');
  mkdirSync(cli, { recursive: true });
  const log = join(root, 'cli-calls.log');
  const reportPath = join(root, 'report.json');
  if (report !== undefined) writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(join(cli, 'cli.js'), [
    "import { appendFileSync, copyFileSync, mkdirSync } from 'node:fs';",
    "import { dirname } from 'node:path';",
    `appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
    `if (${write && report !== undefined}) { const out = process.env.PLAYWRIGHT_JSON_OUTPUT_FILE; mkdirSync(dirname(out), { recursive: true }); copyFileSync(${JSON.stringify(reportPath)}, out); }`,
  ].join('\n'));
  writeStub(join(bin, 'npm'), 'exit 0');
  if (staleReport !== undefined) {
    for (const file of ['two-computer-loop', 'two-computer-admission', 'two-computer-summary-retry', 'two-computer-pause-stop', 'two-computer-offline']) {
      const path = join(root, 'test-artifacts', 'browser-verify', 'rollout', `${file}.spec.mjs.json`);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify(staleReport));
    }
  }
  symlinkSync(join(REPO, 'scripts'), join(root, 'scripts'), 'dir');
  return { root, log, run: (args) => spawnSync(process.execPath, [join(REPO, 'scripts', 'test-two-computer.mjs'), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } }) };
}

test('release gate: browser-verify --release --list exits nonzero and never starts Playwright', () => {
  const lane = browserLane({ report: GOOD });
  const result = lane.run(['--release', '--list']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(lane.log), false, 'no npm or npx call should happen for a rejected release run');
});

test('release gate: browser-verify --release with an empty report exits nonzero', () => {
  const lane = browserLane({ report: EMPTY });
  const result = lane.run(['--release']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /no test executed/);
});

test('release gate: browser-verify --release passes a full run where every test passed on its first attempt', () => {
  const lane = browserLane({ report: GOOD });
  const result = lane.run(['--release']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('exploratory browser-verify still forwards Playwright arguments and exits with Playwright\'s status', () => {
  const lane = browserLane({ report: GOOD });
  const result = lane.run(['--list']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(readFileSync(lane.log, 'utf8'), /npx playwright test -c playwright\.verify\.config\.mjs --list/);
});

test('release gate: two-computer --release with any argument exits nonzero and runs no journey', () => {
  const lane = twoComputerLane({ report: GOOD });
  const result = lane.run(['--release', '--list']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(existsSync(lane.log), false);
});

test('release gate: two-computer --release fails when a journey report is empty', () => {
  const lane = twoComputerLane({ report: EMPTY });
  const result = lane.run(['--release']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /no test executed/);
});

test('release gate: two-computer --release fails on a stale report from an earlier run', () => {
  const lane = twoComputerLane({ report: GOOD, write: false, staleReport: GOOD });
  const result = lane.run(['--release']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /no fresh report/);
});

test('release gate: two-computer --release passes when all five journeys write a complete report', () => {
  const lane = twoComputerLane({ report: GOOD });
  const result = lane.run(['--release']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(readFileSync(lane.log, 'utf8').trim().split('\n').length, 5);
});

// Passed only on the second attempt: Playwright reports it as "flaky" and its exit status can be 0.
const FLAKY = {
  suites: [{ title: 'lane', specs: [{
    title: 'opens the lane', annotations: [{ type: 'slice', description: 'S1' }, { type: 'check', description: 'loads' }],
    tests: [{ annotations: [{ type: 'slice', description: 'S1' }, { type: 'check', description: 'loads' }], status: 'flaky',
      results: [{ status: 'failed', error: { message: 'first attempt error: boom\nexpected visible' } }, { status: 'passed' }] }],
  }] }],
};

test('release gate: a test that failed its first attempt and passed on a retry fails the release gate', () => {
  const lane = browserLane({ report: FLAKY });
  const result = lane.run(['--release']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /retried: opens the lane \(attempts: failed, passed\)/);
});

test('exploratory report keeps the first attempt\'s error next to the retry instead of showing only the last attempt', () => {
  const lane = browserLane({ report: FLAKY });
  const result = lane.run([]);
  assert.match(result.stdout, /attempt 1: failed - first attempt error: boom/);
  assert.match(result.stdout, /attempt 2: passed/);
});

// test.fail(): Playwright reports the status "expected" because the product assertion failed as declared.
const EXPECTED_FAILURE = (known) => ({
  suites: [{ title: 'lane', specs: [{
    title: 'opens the lane', annotations: [{ type: 'slice', description: 'S1' }, { type: 'check', description: 'loads' }],
    tests: [{ annotations: [{ type: 'slice', description: 'S1' }, { type: 'check', description: 'loads' }, ...(known ? [{ type: 'known', description: 'known: ISSUE-7' }] : [])],
      status: 'expected', expectedStatus: 'failed', results: [{ status: 'failed', error: { message: 'loads: expected visible' } }] }],
  }] }],
});

test('release gate: an expected failure with no known annotation is not a pass', () => {
  const lane = browserLane({ report: EXPECTED_FAILURE(false) });
  const result = lane.run(['--release']);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /expected failure without a known annotation: opens the lane/);
});

test('exploratory table shows an unnamed expected failure as FAIL, never pass', () => {
  const lane = browserLane({ report: EXPECTED_FAILURE(false) });
  const result = lane.run([]);
  const row = result.stdout.split('\n').find(line => line.startsWith('S1'));
  assert.match(row ?? '', /FAIL/, result.stdout);
  assert.doesNotMatch(row ?? '', /pass/);
});

test('a named expected failure stays expected-fail and passes the release gate', () => {
  const lane = browserLane({ report: EXPECTED_FAILURE(true) });
  const result = lane.run(['--release']);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /exp:known: ISSUE-7/);
});

// The stub writes no report (as with a --reporter override), and an earlier run's green report is still on disk.
test('a run that writes no report cannot reuse the green report of an earlier run', () => {
  const lane = browserLane({ report: undefined });
  mkdirSync(join(lane.root, 'test-artifacts', 'browser-verify'), { recursive: true });
  writeFileSync(join(lane.root, 'test-artifacts', 'browser-verify', 'results.json'), JSON.stringify(GOOD));
  for (const args of [['--release'], []]) {
    const result = lane.run(args);
    assert.notEqual(result.status, 0, `${args.join(' ') || 'exploratory'}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, /no results at/);
  }
});

test('a corrupt report fails the run even when Playwright exits 0', () => {
  const lane = browserLane({ report: 'not json {' });
  const result = lane.run([]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /no results at/);
});
