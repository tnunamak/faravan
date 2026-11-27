import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startSbxDockerLogin} from '../lib/sbx-login.mjs';
import {createSignin, SIGNIN_DIAGNOSTIC_TARGETS} from '../lib/v1/signin.mjs';

// Behavior 3: `sbx login` exits before it prints a sign-in URL. The flow records a sanitized failure
// class and the exit code read from stderr, and a Docker flow writes a diagnostic row.
// Hermetic: a fake `sbx` shell script in a temp dir; no real sbx, Docker, network or browser.
// New seam (smallest): the SbxLoginError carries `exitCode` (number) and `failureClass` (a short
// lowercase_snake string); createSignin's onDiagnostic event for the flow carries the same two fields.
const SECRET = 'tok_SECRET_do_not_log_9f2c';
async function fakeSbx(t) {
  const dir = await mkdtemp(join(tmpdir(), 'acc-s4-login-'));
  const sbx = join(dir, 'sbx');
  await writeFile(sbx, ['#!/bin/sh',
    'if [ "$1" = "login" ]; then',
    `  echo "error: failed to open browser: exec: xdg-open: not found (token=${SECRET})" >&2`,
    '  exit 3',
    'fi',
    'exit 0'].join('\n'));
  await chmod(sbx, 0o755);
  return sbx;
}
const start = sbx => startSbxDockerLogin({loginBin: sbx, env: {PATH: process.env.PATH}, urlTimeoutMs: 3000,
  signedIn: async () => false, probe: async () => ({checks: []})});

test('an early sbx login exit records the exit code and a sanitized failure class from stderr', async t => {
  const sbx = await fakeSbx(t);
  const error = await start(sbx).then(() => null, e => e);
  assert.ok(error, 'the flow fails: no URL was printed');
  // Today stderr is never read (stdio pipe, no 'data' listener), so only the message "(exit 3)" survives.
  assert.equal(error.exitCode, 3, 'the exit code is recorded as a number');
  assert.match(String(error.failureClass), /^[a-z][a-z0-9_]{2,40}$/, 'a finite class, not raw stderr');
  assert.doesNotMatch(JSON.stringify({m: error.message, c: error.failureClass}), new RegExp(SECRET), 'no raw stderr or token leaks');
});

test('the flow diagnostic for an early Docker login exit carries the sanitized class and exit code', async t => {
  const sbx = await fakeSbx(t);
  const events = [];
  const signin = createSignin({adapters: async () => [], backend: () => ({}), onComplete: async () => {},
    startDocker: () => start(sbx), onDiagnostic: event => events.push(event)});
  await signin.start('docker').catch(() => {});
  const event = events.find(e => e.target === 'docker');
  assert.ok(event, 'a diagnostic event was emitted for the docker flow');
  assert.equal(event.exitCode, 3);
  assert.match(String(event.failureClass), /^[a-z][a-z0-9_]{2,40}$/);
  assert.doesNotMatch(JSON.stringify(event), new RegExp(SECRET));
});

test('a Docker flow is a diagnostic target, so the app writes its row', () => {
  // app.mjs onDiagnostic drops every target not in SIGNIN_DIAGNOSTIC_TARGETS, so no docker row is written today.
  assert.ok(SIGNIN_DIAGNOSTIC_TARGETS.includes('docker'));
});
