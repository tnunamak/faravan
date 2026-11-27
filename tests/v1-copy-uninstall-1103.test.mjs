import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {OPS} from '../lib/v1/ops/registry.mjs';
import {opHelp, runOpsCommand} from '../lib/v1/ops/cli.mjs';
import {problemForError, failureMessage} from '../lib/v1/cli.mjs';
import {LENDING_PARAMETERS} from '../lib/v1/lending-policy.mjs';
import {DOCKER_SIGNED_OUT_MESSAGE} from '../lib/v1/docker-state.mjs';

test('all operation help avoids missing confirmation inputs', () => {
  for (const op of OPS) assert.doesNotMatch(opHelp(op), /undefined/, op.id);
});
test('validated job and membership confirmations name their target', () => {
  for (const [id, input] of [['approvals.accept',{id:'job1'}], ['circles.approve_device',{circle:'Friends'}]]) {
    const op = OPS.find(op => op.id === id);
    assert.doesNotMatch(op.confirm(input), /undefined/);
  }
});
test('Docker sign-in copy does not infer a previous sign-in', () => {
  assert.equal(DOCKER_SIGNED_OUT_MESSAGE, 'Sign in to Docker to lend.');
});
test('lending timeout explains how to check lending', async () => {
  let text = '';
  const code = await runOpsCommand(['lending','on','--yes'], {
    client:{call:async () => {throw Object.assign(new Error('timeout'), {code:'timeout'});}},
    stdout:{write:s => {text+=s;}}, stderr:{write:s => {text+=s;}}
  });
  assert.equal(code, 5);
  assert.match(text, /Lending has not confirmed yet.*faravan lending get/);
  assert.doesNotMatch(text, /job is still pending/);
});
test('weekly reserve copy describes the lending setting without promising never', () => {
  assert.equal(LENDING_PARAMETERS.keepPct.description, "Faravan doesn't lend the last part of each week's usage, set as a percentage.");
});
test('update hold has a specific headline', () => {
  assert.equal(failureMessage('update_in_progress'), 'Lending waits while Faravan finishes an update.');
});
test('host timeout exceptions map to network error without exposing exception text', () => {
  for (const name of ['TimeoutError','AbortError']) {
    const problem = problemForError(new DOMException('private host details', name));
    assert.equal(problem.code, 'network_error');
    assert.equal(problem.message, "The circle's host is not responding. Try again when it is back.");
  }
  assert.equal(problemForError(Object.assign(new Error(), {code:'cancelled',name:'AbortError'})).code, 'cancelled');
});
