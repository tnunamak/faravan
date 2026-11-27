import './helpers/no-browser.mjs';
// Known-bad control for the CI bundle-currency check. The old workflow piped `git status` into `grep -q .` inside an
// `if`, so a failing git (no output) read as "clean". The check now lives in scripts/check-public-v1-current.sh.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(REPO, 'scripts', 'check-public-v1-current.sh');

// Runs the currency check with a stub `git` that prints `stdout` and exits with `code`.
function checkWithGit({ stdout = '', code = 0 }) {
  const dir = mkdtempSync(join(tmpdir(), 'gate-false-green-ci-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s' ${JSON.stringify(stdout)}\nexit ${code}\n`, { mode: 0o755 });
  return spawnSync('sh', [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}` } });
}

test('CI runs the currency check as a script, not as a grep inside an if', () => {
  const workflow = readFileSync(join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
  const step = workflow.slice(workflow.indexOf('UI tests and built bundle is current'), workflow.indexOf('uses: actions/setup-go'));
  assert.match(step, /sh scripts\/check-public-v1-current\.sh/);
  assert.doesNotMatch(step, /grep -q/);
});

test('git status that fails with no output fails the currency check instead of passing it', () => {
  const result = checkWithGit({ code: 128 });
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /cannot inspect public\/v1/);
});

test('a stale public/v1 fails the currency check and names the files', () => {
  const result = checkWithGit({ stdout: ' M public/v1/index.js\n' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /public\/v1 is stale/);
});

test('a clean public/v1 passes the currency check', () => {
  assert.equal(checkWithGit({}).status, 0);
});
