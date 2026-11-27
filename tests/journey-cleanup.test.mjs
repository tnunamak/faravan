import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {finishJourney, processesUnder} from '../packaging/journey/cleanup.mjs';
import {fileURLToPath} from 'node:url';

const cleanup = fileURLToPath(new URL('../packaging/journey/cleanup.mjs', import.meta.url));
const inactive = ['not_needed', 'not_needed', 'not_needed', 'not_needed'];

test('cleanup fails with a survivor and retains a failed run; a clean pass removes disposable directories', async () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-cleanup-'));
  for (const name of ['owner', 'friend', 'install-media', 'smoke']) fs.mkdirSync(path.join(run, name));
  fs.writeFileSync(path.join(run, 'smoke', 'owner.log'), 'owner log');
  const summary = () => JSON.parse(fs.readFileSync(path.join(run, 'summary.json'), 'utf8'));
  const writeSummary = () => fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({pass: false, journeyChecksPassed: true, steps: []}));
  writeSummary();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {cwd: run, stdio: 'ignore'});
  try {
    assert.ok(processesUnder(run).includes(child.pid));
    const command = spawnSync(process.execPath, [cleanup, run, '0', ...inactive], {encoding: 'utf8'});
    assert.equal(command.status, 1);
    assert.doesNotMatch(command.stdout, /PASS journey/);
    writeSummary();
    assert.equal(finishJourney(run, 0, inactive), false);
    assert.equal(summary().pass, false);
    assert.ok(summary().steps.at(-1).survivingPids.includes(child.pid));
    assert.ok(fs.existsSync(path.join(run, 'owner')));
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
  }
  writeSummary();
  assert.equal(finishJourney(run, 1, inactive), false);
  assert.ok(fs.existsSync(path.join(run, 'smoke')));
  assert.equal(summary().pass, false);
  assert.equal(summary().steps.at(-1).pass, true);
  assert.equal(fs.readFileSync(path.join(run, 'logs', 'smoke', 'owner.log'), 'utf8'), 'owner log');
  writeSummary();
  assert.equal(finishJourney(run, 0, inactive), true);
  assert.ok(fs.existsSync(path.join(run, 'summary.json')));
  assert.equal(fs.readFileSync(path.join(run, 'logs', 'smoke', 'owner.log'), 'utf8'), 'owner log');
  for (const name of ['owner', 'friend', 'install-media', 'smoke']) assert.equal(fs.existsSync(path.join(run, name)), false);
  fs.rmSync(run, {recursive: true});
});

test('cleanup command prints PASS exactly once only after success', () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-verdict-'));
  try {
    const write = () => fs.writeFileSync(path.join(run, 'summary.json'), JSON.stringify({pass: false, journeyChecksPassed: true, steps: [], smoke: {admissionMode: 'automatic'}}));
    write();
    const failed = spawnSync(process.execPath, [cleanup, run, '1'], {encoding: 'utf8'});
    assert.equal(failed.status, 1);
    assert.doesNotMatch(failed.stdout, /PASS journey/);
    write();
    const unproven = spawnSync(process.execPath, [cleanup, run, '0'], {encoding: 'utf8'});
    assert.equal(unproven.status, 1);
    assert.doesNotMatch(unproven.stdout, /PASS journey/);
    write();
    const passed = spawnSync(process.execPath, [cleanup, run, '0', ...inactive], {encoding: 'utf8'});
    assert.equal(passed.status, 0);
    assert.equal(passed.stdout, 'PASS journey admission=automatic\n');
    assert.equal(JSON.parse(fs.readFileSync(path.join(run, 'summary.json'), 'utf8')).pass, true);
  } finally { fs.rmSync(run, {recursive: true}); }
});

test('a failed log copy leaves every disposable tree and records a failed cleanup', t => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-log-copy-'));
  t.after(() => fs.rmSync(run, {recursive: true, force: true}));
  const trees = ['owner', 'friend', 'install-media', 'smoke'];
  for (const name of trees) fs.mkdirSync(path.join(run, name));
  const sourceLog = path.join(run, 'smoke', 'owner.log');
  fs.writeFileSync(sourceLog, 'owned synthetic log\n');
  fs.mkdirSync(path.join(run, 'logs', 'smoke', 'owner.log'), {recursive: true});
  const summaryPath = path.join(run, 'summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify({pass: false, journeyChecksPassed: true, steps: []}));

  const result = spawnSync(process.execPath, [cleanup, run, '0', ...inactive], {encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /PASS journey/);
  assert.match(result.stderr, /EISDIR|ENOTDIR|EEXIST/);
  const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  assert.equal(summary.pass, false);
  assert.equal(summary.steps.at(-1).name, 'cleanup');
  assert.equal(summary.steps.at(-1).pass, false);
  assert.equal(fs.readFileSync(sourceLog, 'utf8'), 'owned synthetic log\n');
  for (const name of trees) assert.equal(fs.statSync(path.join(run, name)).isDirectory(), true);
});

test('a verified failed journey removes its sandbox home after its daemon exits', async () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-failed-home-'));
  const base = fs.mkdtempSync('/tmp/fj-');
  const home = path.join(base, '.fsbx', 'fe0000');
  const summaryPath = path.join(run, 'summary.json');
  const writeSummary = () => fs.writeFileSync(summaryPath, JSON.stringify({pass:false, steps:[]}));
  const cleanupStep = () => JSON.parse(fs.readFileSync(summaryPath)).steps.at(-1);
  fs.mkdirSync(home, {recursive:true});
  fs.writeFileSync(path.join(home, 'owned-runtime'), 'fixture');
  fs.writeFileSync(path.join(base, '.journey-run'), '/an/unrelated/run\n');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {env:{...process.env, HOME:home}, stdio:'ignore'});
  try {
    writeSummary();
    assert.equal(finishJourney(run, 1, inactive, base), false);
    assert.equal(cleanupStep().retainedSandboxBase, base);
    assert.equal(fs.existsSync(home), true);
    fs.writeFileSync(path.join(base, '.journey-run'), run + '\n');

    writeSummary();
    assert.equal(finishJourney(run, 1, inactive, base), false);
    assert.ok(cleanupStep().survivingPids.includes(child.pid));
    assert.equal(fs.existsSync(home), true);
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));

    writeSummary();
    assert.equal(finishJourney(run, 1, inactive, base), false);
    assert.equal(cleanupStep().pass, true);
    assert.equal(fs.existsSync(base), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await new Promise(resolve => child.once('exit', resolve));
    }
    fs.rmSync(base, {recursive:true, force:true});
    fs.rmSync(run, {recursive:true, force:true});
  }
});

test('missing summary still reports surviving PIDs and fails', async () => {
  const run = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-missing-summary-'));
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {cwd: run, stdio: 'ignore'});
  try {
    const result = spawnSync(process.execPath, [cleanup, run, '1'], {encoding: 'utf8'});
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(`Journey cleanup left processes: .*\\b${child.pid}\\b`));
    assert.match(result.stderr, /could not read summary/);
    assert.doesNotMatch(result.stdout, /PASS journey/);
  } finally {
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    fs.rmSync(run, {recursive: true});
  }
});

test('the launcher refuses an existing run directory before writing into it', t => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-run-collision-'));
  t.after(() => fs.rmSync(fixture, {recursive: true, force: true}));
  const source = path.join(fixture, 'source');
  const home = path.join(fixture, 'home');
  const bin = path.join(fixture, 'bin');
  const scripts = path.join(source, 'packaging', 'journey');
  fs.mkdirSync(scripts, {recursive: true});
  fs.mkdirSync(bin);
  const launcher = path.join(scripts, 'new-user-journey.sh');
  fs.copyFileSync(new URL('../packaging/journey/new-user-journey.sh', import.meta.url), launcher);
  fs.writeFileSync(path.join(bin, 'git'), '#!/bin/sh\ncase "$3" in rev-parse) echo fixture-head;; status) exit 0;; *) exit 2;; esac\n', {mode:0o700});
  fs.writeFileSync(path.join(bin, 'date'), '#!/bin/sh\necho 20261120T000000Z\n', {mode:0o700});
  fs.writeFileSync(path.join(source, 'packaging', 'build.sh'), 'echo attempted-build; exit 77\n');
  fs.copyFileSync(new URL('../packaging/journey/cleanup.mjs', import.meta.url), path.join(scripts, 'cleanup.mjs'));
  const root = path.join(home, '.tmp', 'faravan-journey');
  const prior = '{"journeyChecksPassed":true,"pass":true,"steps":[]}\n';
  const result = spawnSync('bash', ['-c', `
    prior_run="$HOME/.tmp/faravan-journey/run-20261120T000000Z-$$"
    mkdir -p -m 750 "$prior_run"
    printf '%s' "$2" >"$prior_run/summary.json"
    exec bash "$1" --synthetic
  `, 'collision', launcher, prior], {
    env:{...process.env, HOME:home, PATH:bin + path.delimiter + process.env.PATH}, encoding:'utf8', timeout:7000,
  });
  assert.ifError(result.error);
  const paths = fs.readdirSync(root);
  assert.equal(paths.length, 1);
  const run = path.join(root, paths[0]);
  assert.equal(fs.readFileSync(path.join(run, 'summary.json'), 'utf8'), prior);
  assert.equal(fs.statSync(run).mode & 0o777, 0o750);
  assert.deepEqual(fs.readdirSync(run), ['summary.json']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /refusing journey: cannot create a new run directory/);

  const fresh = spawnSync('bash', [launcher, '--synthetic'], {
    env:{...process.env, HOME:home, PATH:bin + path.delimiter + process.env.PATH}, encoding:'utf8', timeout:7000,
  });
  assert.ifError(fresh.error);
  assert.equal(fresh.status, 77, 'the fresh directory reaches the synthetic build sentinel');
  const nextPaths = fs.readdirSync(root).filter(name => name !== paths[0]);
  assert.equal(nextPaths.length, 1);
  const next = path.join(root, nextPaths[0]);
  assert.equal(fs.statSync(next).mode & 0o777, 0o700);
  assert.equal(fs.readFileSync(path.join(next, 'build-release.log'), 'utf8'), 'attempted-build\n');
  assert.equal(fs.readFileSync(path.join(run, 'summary.json'), 'utf8'), prior);
});
