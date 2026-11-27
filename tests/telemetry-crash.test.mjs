import './helpers/no-browser.mjs';
// The crash marker: a dying process leaves one inbox file, the default crash is unchanged, and nothing private is written.
import { tempDir } from './helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {createConsent} from '../lib/v1/telemetry/consent.mjs';
import { writeCrashFile, framesOf } from '../lib/v1/telemetry/crash.mjs';
import { parseInboxFile } from '../lib/v1/telemetry/catalog.mjs';
import { makeTelemetry, settle,RELEASE,catalogRemoteFactory } from './helpers/telemetry-harness.mjs';
import { appFixture } from './helpers/v1-app-fixture.mjs';

const CHILD = fileURLToPath(new URL('./fixtures/telemetry-crash-child.mjs', import.meta.url));
const run = (env, how) => spawnSync(process.execPath, [CHILD], {env: {PATH: process.env.PATH, HOME: process.env.HOME, HOW: how, ...env}, encoding: 'utf8'});
const scratch = () => {const dir=tempDir('tel-crash-');writeFileSync(join(dir,'policy.json'),JSON.stringify({version:2,level:'on',region:'US',noticeShownAt:1,decidedAt:1,generation:1}));createConsent({dir,base:dir,uploadable:true}).grantRemoteLease(1);return dir;};
const files = dir => { try { return readdirSync(join(dir, 'inbox')).filter(f => f.endsWith('.json')); } catch { return []; } };
const read = dir => parseInboxFile(readFileSync(join(dir, 'inbox', files(dir)[0]), 'utf8'));

test('the default crash is byte-identical with the monitor installed: same stderr, same exit code', () => {
  for (const how of ['throw', 'reject']) {
    const dir = scratch();
    const plain = run({}, how), watched = run({MONITOR_DIR: dir}, how);
    assert.equal(watched.status, plain.status, how + ': exit code');
    assert.equal(plain.status, 1);
    assert.equal(watched.stderr, plain.stderr, how + ': stderr');
    assert.equal(watched.stdout, plain.stdout);
    assert.equal(files(dir).length, 1, how + ': one crash file');
    rmSync(dir, {recursive: true, force: true});
  }
});

test('the crash file names the kind, the error class and shipped frames only: no message, no private path', () => {
  const dir = scratch();
  run({MONITOR_DIR: dir}, 'throw');
  const {origin, gen, record} = read(dir);
  assert.equal(origin, 'crash');
  assert.equal(gen,1,'generation of the acknowledged policy');
  assert.deepEqual([record.name, record.attrs['crash.kind'], record.attrs['js.error_class']], ['app.crash', 'uncaught_exception', 'TypeError']);
  const text = readFileSync(join(dir, 'inbox', files(dir)[0]), 'utf8');
  assert.ok(!/private message|alice|\/home|secret/.test(text));
  assert.deepEqual(record.attrs.frames, [], 'frames outside the shipped files are dropped');
  const again = scratch();
  run({MONITOR_DIR: again}, 'reject');
  assert.equal(read(again).record.attrs['crash.kind'], 'unhandled_rejection');
  assert.equal(read(again).record.attrs['js.error_class'], 'RangeError');
  for (const d of [dir, again]) rmSync(d, {recursive: true, force: true});
});

test('frames map to shipped files and keep a line number; everything else is dropped', () => {
  const error = {stack: ['Error: x with /home/alice/secret', '    at run (file:///usr/lib/faravan/lib/v1/app.mjs:1203:9)', '    at /home/alice/work/x.js:4:1', '    at async Object.<anonymous> (/opt/faravan/bin/faravan:88:3)',
    '    at node:internal/process:1:1'].join('\n')};
  assert.deepEqual(framesOf(error), [{file: 'lib/v1/app.mjs', line: 1203}, {file: 'bin/faravan', line: 88}]);
  assert.deepEqual(framesOf({stack: undefined}), []);
  assert.equal(framesOf({stack: Array.from({length: 40}, () => '    at f (/x/lib/v1/app.mjs:1:1)').join('\n')}).length, 16);
});

test('no file is written when telemetry is off, a switch is set, the policy is corrupt, or the inbox is full', () => {
  const dir = scratch();
  const crash = options => writeCrashFile({dir, env: {}, kind: 'panic', error: new Error('x'), ...options});
  assert.equal(crash({env: {FARAVAN_NO_TELEMETRY: '1'}}), false);
  assert.equal(crash({env: {DO_NOT_TRACK: '1'}}), false);
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({version: 1, level: 'off', region: null, noticeShownAt: 1, decidedAt: 1, generation: 4}));
  assert.equal(crash(), false, 'level off');
  writeFileSync(join(dir, 'policy.json'), '{ broken');
  assert.equal(crash(), false, 'corrupt');
  writeFileSync(join(dir, 'policy.json'), JSON.stringify({version: 2, level: 'on', region: 'US', noticeShownAt: 1, decidedAt: 1, generation: 7}));
  createConsent({dir,base:dir,uploadable:true}).grantRemoteLease(7);
  assert.equal(crash(), true);
  assert.equal(read(dir).gen, 7, 'the generation is copied from the policy');
  mkdirSync(join(dir, 'inbox'), {recursive: true});
  for (let i = 0; i < 200; i++) writeFileSync(join(dir, 'inbox', 'x' + i + '.json'), '{}');
  assert.equal(crash(), false, 'the inbox holds 200 files');
  rmSync(dir, {recursive: true, force: true});
});

test('a second crash within five minutes sets crash_loop', () => {
  const dir = scratch();
  createConsent({dir,base:dir,uploadable:true,now:()=>1_000_000}).grantRemoteLease(1);
  assert.equal(writeCrashFile({dir, env: {}, kind: 'uncaught_exception', error: new Error('a'), now: () => 1_000_000}), true);
  assert.equal(writeCrashFile({dir, env: {}, kind: 'uncaught_exception', error: new Error('b'), now: () => 1_100_000}), true);
  const rows = files(dir).map(f => parseInboxFile(readFileSync(join(dir, 'inbox', f), 'utf8')).record.attrs.crash_loop).sort();
  assert.deepEqual(rows, [false, true]);
  rmSync(dir, {recursive: true, force: true});
});

test('a crash file becomes app.crash and crash.count on the next start, and a clean close leaves no unclean-exit marker', async () => {
  const h = makeTelemetry();
  assert.ok(writeCrashFile({dir: h.dir, now:h.clock.now, env: {}, kind: 'uncaught_exception', error: new TypeError('x'), uptimeMs: 90_000}));
  h.tel.start();
  await settle(h);
  const names = h.transport.records().map(r => r.name);
  assert.ok(names.includes('app.crash') && names.includes('crash.count'));
  await h.tel.close();
  const again = makeTelemetry({dir: h.dir, level: null, clock: h.clock, transport: h.transport});
  again.tel.start();
  await settle(again);
  assert.ok(!again.transport.records().some(r => r.name === 'app.unclean_exit'), 'closed cleanly: no marker');
  await again.tel.close();
});

test('a start that fails leaves an app.crash start_failed marker, but not for an app that is simply already running', { timeout: 120000 }, async t => {
  const f = await appFixture(t);
  const first = (await f.start('one')).app;
  const home = await f.home('two');
  mkdirSync(join(home,'v1','telemetry'),{recursive:true});writeFileSync(join(home,'v1','telemetry','policy.json'),JSON.stringify({version:2,level:'on',region:'US',noticeShownAt:1,decidedAt:1,generation:1}));
  await assert.rejects(f.start('two', {port:new URL(first.origin).port*1,env:{},version:RELEASE,telemetryOptions:{remoteFactory:catalogRemoteFactory}}), error => error.code === 'EADDRINUSE' || /EADDRINUSE|address/i.test(String(error.message)));
  const dir = join(home, 'v1', 'telemetry');
  assert.equal(files(dir).length, 1);
  const {record} = read(dir);
  assert.equal(record.attrs['crash.kind'], 'start_failed');
  assert.equal(record.attrs.errno, 'EADDRINUSE');
  // The same home started twice is an expected refusal, not a crash.
  const before = files(join(await f.home('one'), 'v1', 'telemetry')).length;
  await assert.rejects(f.start('one'));
  assert.equal(files(join(await f.home('one'), 'v1', 'telemetry')).length, before);
});
