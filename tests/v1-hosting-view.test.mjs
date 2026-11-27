import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostingView, setKeepAwake } from '../lib/v1/hosting-view.mjs';

// H1: what the app says about the circle this computer hosts is read from the host's own files and never written.
const circle = {id: 'circle-1', name: 'Weekend projects'};
const device = {keyId: 'me', listCircles: async () => [circle], rosterCache: () => ({get: async () => ({current: {payload: {members: [{key_id: 'me'}, {key_id: 'a'}, {key_id: 'b'}]}}})})};
const presence = async () => ({devices: [{device: 'me', last_poll_at: '2026-10-19T09:59:00Z'}, {device: 'a', last_poll_at: '2026-10-19T09:58:00Z', last_heartbeat_at: '2026-10-19T09:57:00Z'}, {device: 'b', last_poll_at: null, last_heartbeat_at: null}]});
const NOW = () => Date.parse('2026-10-19T10:00:00Z');
async function home(t, {config, status}) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-hosting-')); t.after(() => rm(dir, {recursive: true, force: true}));
  if (config) await writeFile(join(dir, 'host.json'), JSON.stringify({schema_version: 1, protocol_version: 1, port: 8787, collective_name: 'Weekend projects', status_path: join(dir, 'status.json'), circle_id: circle.id, ...config}));
  if (status) await writeFile(join(dir, 'status.json'), JSON.stringify({protocol_version: 1, pid: process.pid, port: 8787, status: 'public_listening', ...status}));
  return dir;
}
const view = (dir, over = {}) => hostingView({home: dir, device, presence, now: NOW,processExists:status=>status?.pid===process.pid, ...over});

test('a computer that has not hosted anything says so and nothing else', async t => {
  assert.deepEqual(await view(await home(t, {})), {configured: false});
  assert.deepEqual(await view(await home(t, {config: {protocol_version: 0}})), {configured: false}, 'a v0 host is not this');
});

test('a running host reports its address, how it is reached, the members and when they last reached it', async t => {
  const dir = await home(t, {config: {v1_origin: 'https://ana-mbp.tail4c2e.ts.net', reachability: {kind: 'url', publicUrl: 'https://ana-mbp.tail4c2e.ts.net'}}, status: {public_url: 'https://ana-mbp.tail4c2e.ts.net'}});
  const out = await view(dir);
  assert.deepEqual([out.configured, out.running, out.name, out.circle, out.origin], [true, true, 'Weekend projects', 'circle-1', 'https://ana-mbp.tail4c2e.ts.net']);
  assert.deepEqual(out.reach, {kind:'url',audience:null});
  assert.equal(out.members, 3);
  assert.equal(out.lastReachedAt, '2026-10-19T09:58:00.000Z', 'the newest contact from anyone but this computer');
  assert.equal(out.addressChanged, null);
});

test('a host whose process is gone is configured but not running, and claims nothing it cannot know', async t => {
  const dir = await home(t, {config: {v1_origin: 'https://ana-friends.ngrok.app', reachability: {kind: 'ngrok', domain: 'ana-friends.ngrok.app'}}, status: {pid: 2 ** 22 + 12345, public_url: 'https://ana-friends.ngrok.app'}});
  const out = await view(dir);
  assert.deepEqual([out.configured, out.running, out.members, out.lastReachedAt, out.addressChanged], [true, false, null, null, null]);
  assert.deepEqual(out.reach, {kind:'ngrok',audience:null});
});

test('an address that differs from the signed one is reported, with both', async t => {
  const dir = await home(t, {config: {v1_origin: 'https://ana-friends.ngrok.app', reachability: {kind: 'ngrok', domain: 'ana-friends.ngrok.app'}}, status: {public_url: 'https://4f2a-81-2-69-142.ngrok.app'}});
  assert.deepEqual((await view(dir)).addressChanged, {expected: 'https://ana-friends.ngrok.app', observed: 'https://4f2a-81-2-69-142.ngrok.app'});
});

test('unreadable files and a presence that fails never throw', async t => {
  const dir = await home(t, {config: {v1_origin: 'https://x.example', reachability: {kind: 'url', publicUrl: 'https://x.example'}}, status: {public_url: 'https://x.example'}});
  await writeFile(join(dir, 'status.json'), '{not json');
  assert.equal((await view(dir)).running, null, 'an unreadable status is unknown, not stopped');
  await writeFile(join(dir, 'status.json'), JSON.stringify({protocol_version: 1, pid: process.pid, status: 'public_listening', public_url: 'https://x.example'}));
  const out = await view(dir, {presence: async () => { throw new Error('down'); }});
  assert.deepEqual([out.running, out.members, out.lastReachedAt], [true, 3, null]);
});

test('the app serves it at /api/hosting, from the host directory it was given', {timeout: 120000}, async t => {
  const { appFixture, api } = await import('./helpers/v1-app-fixture.mjs');
  const f = await appFixture(t);
  const empty = await home(t, {});
  const peer = await f.start('hosting', {coordinatorHome: empty});
  assert.deepEqual(await api(peer.app, '/api/hosting'), {configured: false});
  const hosted = await home(t, {config: {v1_origin: 'https://ana-friends.ngrok.app', reachability: {kind: 'ngrok', domain: 'ana-friends.ngrok.app'}}, status: {public_url: 'https://ana-friends.ngrok.app'}});
  const second = await f.start('hosting2', {coordinatorHome: hosted});
  const out = await api(second.app, '/api/hosting');
  assert.deepEqual([out.configured, out.running, out.processState,out.name, out.reach.kind], [true, null,'unknown', 'Weekend projects', 'ngrok']);
});

// Unknown is not absent: a file that cannot be read says so, with the reason, instead of "not set up" or "stopped".
test('a host config that cannot be read is unreadable with a reason, not unconfigured', async t => {
  const bad = await home(t, {}); await writeFile(join(bad, 'host.json'), '{not json');
  const out = await view(bad);
  assert.equal(out.configured, null); assert.match(out.unreadable.reason, /host\.json/); assert.equal(out.unreadable.what, 'config');
  const notObject = await home(t, {}); await writeFile(join(notObject, 'host.json'), 'null');
  assert.equal((await view(notObject)).configured, null);
  const notFile = await home(t, {}); await mkdir(join(notFile, 'host.json'));
  assert.equal((await view(notFile)).configured, null, 'EISDIR is a failed read, not an absent file');
});

test('a status file that cannot be read is unknown, not stopped', async t => {
  const dir = await home(t, {config: {v1_origin: 'https://x.example', reachability: {kind: 'url', publicUrl: 'https://x.example'}}, status: {public_url: 'https://x.example'}});
  await writeFile(join(dir, 'status.json'), '{not json');
  const out = await view(dir);
  assert.deepEqual([out.configured, out.running, out.processState], [true, null, 'unreadable']);
  assert.match(out.statusError, /coordinator status/);
  await rm(join(dir, 'status.json'));
  const absent = await view(dir);
  assert.deepEqual([absent.running, absent.processState, absent.statusError], [false, 'stopped', undefined], 'a missing status file alone means stopped');
});

test('keep-awake refuses an unreadable config instead of reporting the host as missing', async t => {
  const bad = await home(t, {}); await writeFile(join(bad, 'host.json'), '{not json');
  assert.throws(() => setKeepAwake({home: bad, on: true}), error => error.code === 'host_config_unreadable');
});

test('the app and the ops registry both carry the unreadable state', {timeout: 120000}, async t => {
  const { appFixture, api } = await import('./helpers/v1-app-fixture.mjs');
  const f = await appFixture(t);
  const bad = await home(t, {}); await writeFile(join(bad, 'host.json'), '{not json');
  const peer = await f.start('hosting-bad', {coordinatorHome: bad});
  const out = await api(peer.app, '/api/hosting');
  assert.equal(out.configured, null); assert.match(out.unreadable.reason, /host\.json/);
  const viaOp = await api(peer.app, '/api/ops/hosting.get', {method: 'POST', body: {}});
  assert.equal((viaOp.result ?? viaOp).configured, null, 'hosting.get, which feeds the CLI and MCP, returns the same state');
  const refused = await api(peer.app, '/api/hosting/keep-awake', {method: 'POST', body: {on: true}, status: 409});
  assert.equal(refused.code ?? refused.problem?.code ?? refused.error?.code, 'host_config_unreadable', 'keep-awake does not answer "not found" for a config it could not read');
});

test('creating a circle refuses an unreadable host config, with or without an origin', {timeout: 120000}, async t => {
  const { appFixture, api } = await import('./helpers/v1-app-fixture.mjs');
  const f = await appFixture(t);
  const bad = await home(t, {}); await writeFile(join(bad, 'host.json'), '{not json');
  const peer = await f.start('create-bad-host', {coordinatorHome: bad});
  for (const body of [{name: 'Weekend projects'}, {name: 'Weekend projects', origin: 'https://other.example'}]) {
    const refused = await api(peer.app, '/api/circles', {method: 'POST', body, status: 409});
    assert.equal(refused.code ?? refused.problem?.code ?? refused.error?.code, 'host_config_unreadable', JSON.stringify(body));
  }
});
