import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { discover, judge, parseNodeSummary, ramScratchRoot, runJob } from '../scripts/run-tests.mjs';

const TAP_CLEAN = [
  'TAP version 13', '# Subtest: a', 'ok 1 - a', '# Subtest: b', 'ok 2 - b',
  '# tests 2', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 0',
].join('\n');

test('the summary parser counts registered tests and ignores the file-level entry', () => {
  assert.deepEqual(parseNodeSummary(TAP_CLEAN), { tests: 2, pass: 2, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  // A file with no tests is reported as one file-level entry, which is not a test.
  const empty = 'TAP version 13\n# Subtest: x.test.mjs\nok 1 - x.test.mjs\n# tests 1\n# pass 1\n# fail 0\n# cancelled 0';
  assert.equal(parseNodeSummary(empty).tests, 0);
  assert.equal(parseNodeSummary('no summary here').tests, null);
});

test('judge rejects missing, malformed and duplicate required TAP counters', () => {
  const clean = '# tests 1\n# pass 1\n# fail 0\n# cancelled 0';
  const reasons = output => judge({ kind: 'node', code: 0, summary: parseNodeSummary(output) });
  assert.deepEqual(reasons(clean), []);
  assert.ok(reasons('# tests 1').length > 0, 'a registered test is not evidence it passed');
  for (const label of ['tests', 'pass', 'fail', 'cancelled']) {
    const line = new RegExp(`^# ${label} \\d+$`, 'm');
    for (const output of [
      clean.replace(line, ''),
      clean.replace(line, `# ${label} -1`),
      clean.replace(line, `# ${label} 9007199254740992`),
      clean + `\n# ${label} 1`,
    ]) assert.ok(reasons(output).length > 0, `${label}: incomplete evidence cannot pass`);
  }
  assert.ok(judge({kind: 'node', code: 0, summary: {
    tests: -1, pass: 1, fail: 0, cancelled: 0,
  }}).length > 0, 'wrapper subtraction cannot produce a valid negative count');
});

test('judge passes a clean file and names each way a file can fail', () => {
  const node = (fields) => ({ kind: 'node', code: 0, timedOut: false, leaked: false, summary: { tests: 2, pass: 2, fail: 0, cancelled: 0 }, ...fields });
  assert.deepEqual(judge(node({})), []);
  assert.match(judge(node({ code: 1, summary: { tests: 2, pass: 1, fail: 1, cancelled: 0 } })).join(';'), /exit 1.*1 failed/);
  assert.deepEqual(judge(node({ summary: { tests: 2, pass: 1, fail: 0, cancelled: 1 } })), ['1 cancelled (never settled)']);
  assert.deepEqual(judge(node({ summary: { tests: 0, pass: 0, fail: 0, cancelled: 0 } })), ['zero tests ran']);
  assert.deepEqual(judge(node({ summary: null })), ['no test summary (the harness did not finish)']);
  assert.deepEqual(judge(node({ leaked: true })), ['left child processes running after the file ended (killed)']);
  assert.match(judge(node({ timedOut: true, timeoutMs: 500, code: 1, summary: null })).join(';'), /timed out after 500 ms/);
  assert.deepEqual(judge({ kind: 'shell', code: 0, timedOut: false, leaked: false }), []);
  assert.deepEqual(judge({ kind: 'shell', code: 3, timedOut: false, leaked: false }), ['exit 3']);
});

test('discover selects every Node test file and the shell suites, sorted, with no duplicates', () => {
  const jobs = discover({});
  const nodeNames = jobs.filter((job) => job.kind === 'node').map((job) => job.name);
  assert.ok(nodeNames.length > 40, 'the Node suite has dozens of files');
  assert.deepEqual(nodeNames, [...nodeNames].sort());
  assert.equal(new Set(nodeNames).size, nodeNames.length);
  assert.ok(nodeNames.includes('run-tests.test.mjs'));
  assert.deepEqual(jobs.filter((job) => job.kind === 'shell').map((job) => job.name), ['detect-sbx.sh', 'firewall-helper.sh']);
});

test('Node\'s --test-timeout also caps the whole file, so it is the file budget, not the per-test one', () => {
  // Node applies --test-timeout to the file-level entry too: 120 s there cancelled v1-app before the serial file finished.
  const flag = (jobs) => jobs.filter((job) => job.kind === 'node').map((job) => job.args.find((arg) => arg.startsWith('--test-timeout=')));
  assert.ok(flag(discover({ fileTimeoutMs: 777000 })).every((arg) => arg === '--test-timeout=777000'));
  assert.ok(flag(discover({})).every((arg) => arg === '--test-timeout=600000'), 'default equals the default file watchdog');
});

test('a process that never finishes is killed by its watchdog and reported as a timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-hang-'));
  const result = await runJob({ kind: 'shell', name: 'hang', command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], cwd: dir },
    { dir, fileTimeoutMs: 400 });
  assert.equal(result.timedOut, true);
  assert.ok(result.reasons.some((reason) => reason.startsWith('timed out after 400 ms')));
});

test('a process that prints nothing for the stall limit is killed and reported as stalled', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-stall-'));
  const result = await runJob({ kind: 'shell', name: 'stall', command: process.execPath,
    args: ['-e', "console.log('one line'); setInterval(() => {}, 1000);"], cwd: dir },
  { dir, fileTimeoutMs: 60000, stallMs: 400 });
  assert.equal(result.stalled, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.reasons.some((reason) => reason.startsWith('no output for')));
});

test('a file that leaves a child process behind is killed and reported as a leak', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-leak-'));
  writeFileSync(join(dir, 'leak.test.mjs'), [
    "import test from 'node:test';",
    "import { spawn } from 'node:child_process';",
    "test('leaves an unref-ed child in the group', () => {",
    "  spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).unref();",
    '});',
  ].join('\n'));
  const result = await runJob({ kind: 'node', name: 'leak.test.mjs', cwd: dir, args: ['--test', '--test-reporter=tap', 'leak.test.mjs'] },
    { dir, fileTimeoutMs: 20000 });
  assert.equal(result.leaked, true);
  assert.equal(result.summary.pass, 1);
  assert.ok(result.reasons.includes('left child processes running after the file ended (killed)'));
});

test('a file runs with the run-owned scratch directory as its TMPDIR', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-scratch-'));
  const scratch = mkdtempSync(join(tmpdir(), 'run-tests-owned-'));
  const result = await runJob({ kind: 'shell', name: 'env', command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.TMPDIR + "|" + process.env.TMP + "|" + process.env.TEMP)'], cwd: dir },
  { dir, fileTimeoutMs: 20000, scratch });
  // Each file gets its own directory inside the run scratch, and removes it when the file ends.
  const [tmp, tmpVar, tempVar] = result.output.split('|');
  assert.equal(dirname(tmp), scratch);
  assert.equal(tmpVar, tmp);
  assert.equal(tempVar, tmp);
  assert.deepEqual(readdirSync(scratch), []);
  assert.ok(ramScratchRoot() === null || ramScratchRoot() === '/dev/shm');
});

test('a file that registers no tests fails the run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-zero-'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'empty.test.mjs'), "import test from 'node:test';\n");
  const result = await runJob({ kind: 'node', name: 'empty.test.mjs', cwd: dir, args: ['--test', '--test-reporter=tap', 'empty.test.mjs'] },
    { dir, fileTimeoutMs: 20000 });
  assert.deepEqual(result.reasons, ['zero tests ran']);
});

test('the watchdog also removes the short home and sandbox homes used by a killed file', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'run-tests-short-home-'));
  t.after(() => rmSync(dir, {recursive: true, force: true}));
  const homeHelper = new URL('./helpers/home-isolation.mjs', import.meta.url).href;
  const sandboxHelper = new URL('./helpers/short-sbx-home.mjs', import.meta.url).href;
  const backend = new URL('../lib/docker-backend.mjs', import.meta.url).href;
  const script = `
    delete process.env.FARAVAN_TEST_HOME;
    await import(${JSON.stringify(homeHelper)});
    const {selectSbxHome} = await import(${JSON.stringify(backend)});
    const fallback = selectSbxHome({dataHome:'/long-profile-data-directory-for-run-tests'}).home;
    await import(${JSON.stringify(sandboxHelper)});
    const {dirname} = await import('node:path');
    const {mkdirSync, writeFileSync} = await import('node:fs');
    if (dirname(dirname(fallback)) === dirname(process.env.HOME)) {
      mkdirSync(fallback, {recursive:true});
      writeFileSync(fallback + '/used', 'x');
    }
    console.log(JSON.stringify({home:process.env.HOME, fallback, override:process.env.FARAVAN_SBX_HOME}));
    setInterval(() => {}, 1000);
  `;
  const result = await runJob({kind:'node', name:'short-homes', args:['--input-type=module', '-e', script]},
    {dir, fileTimeoutMs:2500});
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGKILL', 'cleanup must wait for the child exit event');
  const {home, fallback, override} = JSON.parse(result.output.trim());
  try {
    assert.equal(dirname(dirname(fallback)), dirname(home));
    assert.equal(dirname(override), dirname(home));
    for (const target of [home, override, fallback, dirname(home)]) assert.equal(existsSync(target), false, target);
  } finally {
    // These two paths were allocated by the fixture, including before the watchdog fix.
    for (const target of [home, override]) rmSync(target, {recursive:true, force:true});
  }
});
