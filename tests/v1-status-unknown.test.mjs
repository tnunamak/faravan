import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {readLending, lendingLabel, showStatus} from '../lib/v1/status.mjs';

// `faravan status` must tell "no app is running" apart from "the app did not answer".
async function home(t, record) {
  const dir = await mkdtemp(join(tmpdir(), 'spk-status-')); t.after(() => rm(dir, {recursive: true, force: true}));
  await mkdir(join(dir, 'v1'));
  if (record !== undefined) await writeFile(join(dir, 'v1', 'app.json'), typeof record === 'string' ? record : JSON.stringify(record));
  return dir;
}
const live = {pid: process.pid, port: 4999, token: 'tok'};
const reply = (status, body = {}) => async () => new Response(JSON.stringify(body), {status});

test('no app record, or a dead process, is not running', async t => {
  assert.equal(await readLending(await home(t)), null);
  assert.equal(await readLending(await home(t, {...live, pid: 2 ** 22 + 12345})), null);
});

test('an app that answers is returned as is', async t => {
  assert.deepEqual(await readLending(await home(t, live), reply(200, {enabled: true})), {enabled: true});
});

test('an unreadable record, an HTTP error and a timeout are unreadable with a reason, never not running', async t => {
  const timeout = async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), {name: 'TimeoutError'}); };
  for (const [name, dir, fetch] of [
    ['bad json', await home(t, '{not json'), reply(200)],
    ['bad shape', await home(t, {pid: 'x'}), reply(200)],
    ['http 500', await home(t, live), reply(500)],
    ['http 401', await home(t, live), reply(401)],
    ['refused', await home(t, live), async () => { throw new TypeError('fetch failed'); }],
    ['timeout', await home(t, live), timeout],
    ['body not json', await home(t, live), async () => new Response('<html>', {status: 200})],
  ]) {
    const out = await readLending(dir, fetch);
    assert.equal(out?.unreadable, true, name);
    assert.ok(typeof out.reason === 'string' && out.reason.length > 0, name + ' has a reason');
    assert.match(lendingLabel(out), /^Could not read lending status: /, name);
    assert.doesNotMatch(lendingLabel(out), /Not running/, name);
  }
});

test('faravan status shows could not read, in text and in json', async t => {
  const dir = await home(t, live), device = {keyId: 'k'.repeat(40), listCircles: async () => []};
  const run = async argv => { let out = ''; await showStatus(argv, {home: dir, device, fetch: reply(500), stdout: {write: s => { out += s; }}, stderr: {write() {}}}); return out; };
  const text = await run([]);
  assert.match(text, /Lending:\s+Could not read lending status: /); assert.doesNotMatch(text, /Not running|start the app with/);
  const json = JSON.parse(await run(['--json']));
  assert.equal(json.lending.app_running, null); assert.match(json.lending.status, /^Could not read lending status: /); assert.ok(json.lending.read_error);
});

test('a 200 whose body is not a lending status is unreadable, never off or not running', async t => {
  const dir = await home(t, live);
  for (const [name, body] of [['null', null], ['false', false], ['array', []], ['number', 42], ['empty object', {}]]) {
    const out = await readLending(dir, reply(200, body));
    assert.equal(out?.unreadable, true, name);
    assert.ok(typeof out.reason === 'string' && out.reason.length > 0, name + ' has a reason');
    assert.match(lendingLabel(out), /^Could not read lending status: /, name);
  }
});
