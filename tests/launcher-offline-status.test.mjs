import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launchFailure, readLaunchFailure, launchFailureSummary, applyLaunchFailureStatus} from '../lib/v1/launch-status.mjs';

const saved = {version: 1, code: 'sandbox_start_failed', kind: 'Error', at: 123};
const offline = () => ({app_running: false, status: 'Not running', summary: null,
  enabled: false, starting_assumption: null, status_lines: []});
async function homeFor(t) {
  const home = await mkdtemp(join(tmpdir(), 'launcher-status-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  await mkdir(join(home, 'v1'));
  return home;
}

test('saved startup failure augments the existing lending status fields', () => {
  const original = offline();
  const result = applyLaunchFailureStatus(original, saved);
  assert.equal(result.app_running, false);
  assert.equal(result.enabled, false);
  assert.equal(result.starting_assumption, null);
  assert.deepEqual(result.status_lines, []);
  assert.deepEqual(Object.keys(result).sort(), [...Object.keys(original), 'start_failure'].sort());
  assert.equal(result.status, 'Faravan could not start');
  assert.equal(result.summary.phase, 'waiting');
  assert.match(result.summary.reason, /protected workspace could not start/);
  assert.deepEqual(result.start_failure, saved);
  assert.deepEqual(original, offline());
});

test('authenticated live lending wins over an older saved startup failure', () => {
  const live = {...offline(), app_running: true, enabled: true, status: 'Ready for requests',
    summary: {phase: 'ready', headline: 'Ready for requests', reason: 'Ready.', action: null}};
  assert.equal(applyLaunchFailureStatus(live, saved), live);
  assert.equal(Object.hasOwn(live, 'start_failure'), false);
});

test('an authenticated status response wins even when lending could not be read', () => {
  const unknown = {...offline(), app_running: null, enabled: null, read_error: 'Lending could not be read.'};
  assert.equal(applyLaunchFailureStatus(unknown, saved, {liveApp: true}), unknown);
});

test('unreachable app displays saved fixed copy without leaking read errors or extra fields', () => {
  const unknown = {...offline(), app_running: null, enabled: null,
    read_error: 'private /Users/person/token=secret\nError: raw stack'};
  const dirty = {...saved, message: 'private error', path: '/Users/person', stack: 'secret'};
  const result = applyLaunchFailureStatus(unknown, dirty, {liveApp: false});
  assert.equal(result.app_running, null);
  assert.equal(result.enabled, null);
  assert.equal(result.read_error, 'The app did not answer.');
  assert.deepEqual(result.start_failure, saved);
  assert.doesNotMatch(JSON.stringify(result), /private|secret|Users|stack|token=|verdict|receipt|attempt|settled|lease/i);
});

test('saved record reader projects only fixed codes, error classes and time', async t => {
  const home = await homeFor(t);
  await writeFile(join(home, 'v1', 'start-failure.json'), JSON.stringify({...saved,
    kind: '/Users/private', message: 'token=secret', path: '/Users/private', stack: 'private'}));
  assert.deepEqual(readLaunchFailure(home), saved);
  const result = applyLaunchFailureStatus(offline(), readLaunchFailure(home));
  assert.doesNotMatch(JSON.stringify(result), /private|secret|Users|stack|token=/);
});

test('missing or malformed startup records leave ordinary offline status intact', async t => {
  const home = await homeFor(t), original = offline();
  assert.equal(readLaunchFailure(home), null);
  for (const content of ['{malformed', 'null', '[]', JSON.stringify({...saved, version: 2}),
    JSON.stringify({...saved, code: 'private raw text'}), JSON.stringify({...saved, at: -1}),
    JSON.stringify({...saved, at: 1.5}), JSON.stringify({...saved, at: '123'})]) {
    await writeFile(join(home, 'v1', 'start-failure.json'), content);
    assert.equal(readLaunchFailure(home), null);
    assert.equal(applyLaunchFailureStatus(original, readLaunchFailure(home)), original);
  }
  assert.equal(launchFailureSummary(null), null);
});

test('all allowed startup codes have fixed plain-language reasons', () => {
  const codes = ['launch_lock_held', 'app_unavailable', 'app_start_failed', 'sandbox_start_failed',
    'sandbox_ready_timeout', 'sandbox_credential_store_failed', 'cessation_unverified',
    'policy_unenforceable', 'host_disk_low', 'host_disk_unreadable', 'wall_timeout'];
  for (const code of codes) {
    const summary = launchFailureSummary({...saved, code, message: 'secret\n/Users/private'});
    assert.equal(summary.headline, 'Faravan could not start');
    assert.equal(summary.label, 'Needs attention');
    assert.equal(summary.action, null);
    assert.ok(summary.reason.length > 20);
    assert.doesNotMatch(JSON.stringify(summary), /secret|Users|stack|verdict|receipt|attempt|settled|lease|_/i);
  }
});

test('error classification tolerates hostile properties and never copies messages', () => {
  assert.deepEqual(launchFailure({name: 'TypeError', code: 'host_disk_low', message: 'secret'}),
    {code: 'host_disk_low', kind: 'TypeError'});
  assert.deepEqual(launchFailure(new Proxy({}, {get() { throw Error('secret'); }})),
    {code: 'app_start_failed', kind: 'Error'});
});
