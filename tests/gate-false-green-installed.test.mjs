import './helpers/no-browser.mjs';
// Known-bad controls for the installed-candidate verifier. The stub logs invocation, answers only the startup read,
// and fails subsequent operations so journey-check ends quickly. "The verifier ran the binary" is the observable that tells a bound run from an unbound one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = join(REPO, 'scripts', 'verify-installed.sh');

function stubCli(dir, tag, log) {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'faravan');
  writeFileSync(path, `#!/bin/sh\n# build ${tag}\necho "ran $*" >> '${log}'\nif [ "$3" = "update.status" ]; then\n  printf '%s\\n' '{"owner":"development","state":"idle","automatic":false,"currentVersion":"1.2.3"}'\n  exit 0\nfi\nexit 1\n`, { mode: 0o755 });
  return path;
}
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

function passingStub(w, action, firstFails = false) {
  const values = {
    'update.status': {owner:'development', state:'idle', automatic:false, currentVersion:'1.2.3'},
    'status.blockers': {can_lend: !firstFails, blockers: []},
    'agents.list': [{id: 'codex', signedIn: true, useForLending: true}],
    'readiness.get': {ready: true, checks: []},
    'doctor.run': {status: 'ready', checks: []},
    'signin.start': {already_signed_in: true},
    'lending.get': {enabled: false, circle: 'friends'},
    'circles.list': [{id: 'friends', name: 'Friends'}],
    'circles.check': {state: 'approved'},
  };
  writeFileSync(w.installed, [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    'const [group, verb, op] = process.argv.slice(2);',
    "if (group !== 'ops' || verb !== 'call') process.exit(9);",
    'fs.appendFileSync('+JSON.stringify(w.log)+', op + "\\n");',
    'const values = '+JSON.stringify(values)+';',
    "if (op === 'circles.check') { "+action+' }',
    'process.stdout.write(JSON.stringify(values[op] ?? {}));',
    '',
  ].join('\n'), {mode: 0o755});
}

// Only owned fake executables run. Identity changes on the final real journey op.
for (const json of [false, true]) for (const change of ['none', 'bytes', 'replacement', 'link', 'missing']) {
  test('postflight '+change+' identity with '+(json ? 'JSON' : 'table'), () => withWorld(w => {
    const link = join(w.root, 'candidate link');
    symlinkSync(w.installed, link);
    const path = JSON.stringify(w.installed), linkPath = JSON.stringify(link);
    const action = {
      none: '',
      bytes: 'fs.appendFileSync('+path+', "\\n// changed during journey\\n");',
      replacement: 'fs.copyFileSync('+path+', '+path+' + ".new"); fs.renameSync('+path+' + ".new", '+path+');',
      link: 'fs.unlinkSync('+linkPath+'); fs.symlinkSync('+JSON.stringify(w.source)+', '+linkPath+');',
      missing: 'fs.unlinkSync('+path+');',
    }[change];
    passingStub(w, action);
    const result = verify([link, '--expect-path', w.installed, '--expect-sha256', sha256(w.installed), ...(json ? ['--json'] : [])], strippedPath(w));
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, change === 'none' ? 0 : 1, result.stdout + result.stderr);
    assert.match(readFileSync(w.log, 'utf8'), /circles\.check/);
    if (change === 'none') {
      assert.doesNotMatch(result.stderr, /identity changed/);
      if (json) assert.equal(JSON.parse(result.stdout).result, 'PASS');
      else assert.match(result.stdout, /RESULT PASS first_fail=none/);
    } else {
      assert.match(result.stderr, /identity changed/);
      assert.doesNotMatch(result.stdout, /RESULT PASS/);
      if (json) {
        const report = JSON.parse(result.stdout);
        assert.equal(report.result, 'FAIL');
        assert.equal(report.first_fail, 'installed.identity');
        assert.equal(report.steps.at(-1).state, 'FAIL');
      } else assert.match(result.stdout, /RESULT FAIL first_fail=installed\.identity/);
    }
  }));
}

for (const json of [true, false]) {
  test('postflight failure preserves the first journey failure (' + (json ? 'json' : 'table') + ')', () => withWorld(w => {
    passingStub(w, 'fs.unlinkSync('+JSON.stringify(w.installed)+');', true);
    const result = verify([w.installed, '--expect-path', w.installed, '--expect-sha256', sha256(w.installed), ...(json ? ['--json'] : [])], strippedPath(w));
    assert.equal(result.status, 1);
    assert.match(result.stderr, /identity changed/);
    if (json) {
      const report = JSON.parse(result.stdout);
      assert.equal(report.first_fail, 'status.blockers');
      assert.equal(report.result, 'FAIL');
      assert.equal(report.steps.at(-1).step, 'installed.identity');
    } else {
      const observations = result.stdout.trim().split(/\r?\n/).filter(line =>
        /^(status\.blockers|installed\.identity|RESULT )/.test(line));
      assert.equal(observations.length, 3, result.stdout);
      assert.match(observations[0], /^status\.blockers \| FAIL \| /);
      assert.match(observations[1], /^installed\.identity \| FAIL \| 0 \| /);
      assert.equal(observations[2], 'RESULT FAIL first_fail=status.blockers');
    }
  }));
}

test('wrapper retains actual termination signal without claiming success', () => withWorld(w => {
  passingStub(w, "process.kill(process.ppid, 'SIGTERM');");
  const result = verify([w.installed, '--expect-path', w.installed, '--expect-sha256', sha256(w.installed)], strippedPath(w));
  assert.equal(result.error, undefined);
  assert.equal(result.status, null);
  assert.equal(result.signal, 'SIGTERM');
  assert.doesNotMatch(result.stdout, /RESULT PASS/);
}));

function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gate-false-green-installed-')));
  const log = join(root, 'faravan-runs.log');
  const installed = stubCli(join(root, 'installed with spaces'), 'candidate', log);
  const source = stubCli(join(root, 'source-checkout'), 'older source build', log);
  return { root, log, installed, source, ran: () => existsSync(log) };
}

function verify(args, env = process.env) {
  return spawnSync('/bin/sh', [VERIFIER, ...args], { encoding: 'utf8', timeout: 120000, env });
}
function withWorld(run) {
  const w = world();
  try { return run(w); } finally { rmSync(w.root, {recursive: true, force: true}); }
}

test('installed verification without an expected identity refuses to run the binary', () => withWorld(w => {
  const result = verify([w.source]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /identity required/);
  assert.equal(w.ran(), false, 'the binary must not run without an identity');
}));

test('installed verification refuses a healthy older CLI when the candidate digest is expected', () => withWorld(w => {
  const result = verify([w.source, '--expect-path', w.installed, '--expect-sha256', sha256(w.installed)]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /identity mismatch: .* is not the expected installed executable/);
  assert.equal(w.ran(), false, 'the healthy older CLI must not be credited as the candidate');
}));

test('installed verification refuses the right path when its bytes hash to something else', () => withWorld(w => {
  const result = verify([w.installed, '--expect-path', w.installed, '--expect-sha256', sha256(w.source)]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /identity mismatch: .* hashes to/);
  assert.equal(w.ran(), false);
}));

test('installed verification with a matching path and digest runs the candidate through journey-check', () => withWorld(w => {
  verify([w.installed, '--expect-path', w.installed, '--expect-sha256', sha256(w.installed)]);
  assert.equal(w.ran(), true, 'the bound candidate must reach journey-check');
  assert.match(readFileSync(w.log, 'utf8'), /ops call/);
}));

function strippedPath(w, {runtime = 'real', refusingTools = false} = {}) {
  const bin = join(w.root, 'bin');
  mkdirSync(bin);
  if (runtime === 'real') symlinkSync(process.execPath, join(bin, 'node'));
  if (runtime === 'unsupported') writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit 64\n', {mode: 0o755});
  if (refusingTools) for (const name of ['readlink', 'sha256sum'])
    writeFileSync(join(bin, name), '#!/bin/sh\nexit 64\n', {mode: 0o755});
  return {...process.env, PATH: bin};
}
for (const refusingTools of [false, true]) test('portable identity preflight without GNU tools: '+refusingTools, () => withWorld(w => {
  const env = strippedPath(w, {refusingTools});
  const link = join(w.root, 'linked candidate');
  symlinkSync(w.installed, link);
  const result = verify([link, '--expect-path', w.installed, '--expect-sha256', sha256(w.installed)], env);
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(w.ran(), true);
  assert.match(readFileSync(w.log, 'utf8'), /ops call/);
}));
for (const mismatch of ['path', 'digest']) test('stripped PATH rejects '+mismatch+' mismatch before CLI effects', () => withWorld(w => {
  const result = verify([w.installed, '--expect-path', mismatch === 'path' ? w.source : w.installed,
    '--expect-sha256', sha256(mismatch === 'digest' ? w.source : w.installed)], strippedPath(w));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /identity mismatch:/);
  assert.equal(w.ran(), false);
}));
for (const runtime of ['missing', 'unsupported']) test('precise '+runtime+' Node prerequisite with zero CLI effects', () => withWorld(w => {
  const result = verify([w.installed, '--expect-path', w.installed, '--expect-sha256', sha256(w.installed)], strippedPath(w, {runtime}));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 2);
  assert.equal(result.stderr.trim(), runtime === 'missing'
    ? 'runtime required: Node.js (node) is not available'
    : 'unsupported runtime: Node.js must support built-in fs, crypto and child_process');
  assert.equal(w.ran(), false);
}));
for (const digest of ['A'.repeat(64), 'a'.repeat(63), 'g'.repeat(64)]) test('invalid digest is refused before effects: '+digest.slice(0,2)+digest.length, () => withWorld(w => {
  const result = verify([w.installed, '--expect-path', w.installed, '--expect-sha256', digest], strippedPath(w));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /64 lowercase hex/);
  assert.equal(w.ran(), false);
}));
