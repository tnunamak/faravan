import './helpers/no-browser.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import { openV1Store } from '../lib/v1/store.mjs';

// Test-only golden keys (docs/protocol/vectors/golden.json): members 0 and 1 and the root (2) are in the roster.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const keys = [...golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex'))), p.privateKeyFromSeed(Buffer.alloc(32, 5))];
const pub = keys.map(p.exportPublicKey), fp = pub.map(p.fingerprint);
const roster = golden.objects.roster.envelope, circle = roster.payload.circle;
const origin = 'https://coordinator.example', base = origin + '/v1/circles/' + circle;
const start = Date.parse('2026-10-09T12:00:00Z') / 1000;
const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const code = (fn, expected) => assert.throws(fn, e => e instanceof p.ProtocolError && e.code === expected, 'expected ' + expected);

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-leave-'));
  let now = start, n = 0;
  const store = openV1Store({path: join(dir, 'store.sqlite'), circle, origin, rootFingerprint: fp[2], initialRoster: roster, clock: () => now,
    idGenerator: () => 'bbbbbbbb-bbbb-4bbb-8bbb-' + (++n).toString(16).padStart(12, '0')});
  t.after(() => { store.close(); rmSync(dir, {recursive: true, force: true}); });
  const f = {store, epoch: roster.payload.epoch, advance: s => { now += s; }, get now() { return now; }};
  f.ctx = (device, method, route, body, overrides = {}) => ({proof: p.buildRequestProof({circle, roster_epoch: f.epoch, method, target: base + route,
    body: method === 'GET' ? Buffer.alloc(0) : Buffer.from(p.canonicalize(body)), content_type: method === 'GET' ? '' : 'application/json',
    artifact_media_type: '', idempotency_key: method === 'POST' ? randomUUID() : '', created: now, nonce: randomBytes(16).toString('base64url'), ...overrides}, keys[device])});
  f.leave = (signer, as = signer, issued = now, post = signer) => {
    const envelope = p.signEnvelope('leave', {schema: 'faravan.leave.v1', circle, key_id: fp[as], issued_at: iso(issued)}, keys[signer]);
    return store.createLeaveRequest({leave: envelope}, f.ctx(post, 'POST', '/leave-requests', {leave: envelope}));
  };
  f.list = device => store.listLeaveRequests(fp[device], f.ctx(device, 'GET', '/leave-requests'));
  return f;
}

test('a member\'s own signed leave request is stored once and listed to members', t => {
  const f = fixture(t);
  const made = f.leave(1);
  assert.deepEqual([made.key_id, made.state], [fp[1], 'pending']);
  assert.equal(f.leave(1).leave_id, made.leave_id, 'a second request returns the open one');
  const listed = f.list(0).items;
  assert.equal(listed.length, 1);
  assert.equal(p.verifyEnvelope('leave', listed[0].leave, pub[1]).ok, true);
  assert.equal(f.list(1).items.length, 1, 'any member can read the list, as with enrollments');
});


test('the coordinator refuses a leave that is not the caller\'s own', t => {
  const f = fixture(t);
  // Device 1 posts a leave signed by device 0, naming device 0.
  const asZero = p.signEnvelope('leave', {schema: 'faravan.leave.v1', circle, key_id: fp[0], issued_at: iso(f.now)}, keys[0]);
  code(() => f.store.createLeaveRequest({leave: asZero}, f.ctx(1, 'POST', '/leave-requests', {leave: asZero})), 'forbidden');
  // Device 1 posts its own name but a signature by a different key.
  const forged = p.signEnvelope('leave', {schema: 'faravan.leave.v1', circle, key_id: fp[3], issued_at: iso(f.now)}, keys[3]);
  const mixed = {payload: {...forged.payload, key_id: fp[1]}, signature: forged.signature};
  assert.throws(() => f.store.createLeaveRequest({leave: mixed}, f.ctx(1, 'POST', '/leave-requests', {leave: mixed})), p.ProtocolError);
  // A non-member cannot post at all.
  const outsider = p.signEnvelope('leave', {schema: 'faravan.leave.v1', circle, key_id: fp[4], issued_at: iso(f.now)}, keys[4]);
  assert.throws(() => f.store.createLeaveRequest({leave: outsider}, f.ctx(4, 'POST', '/leave-requests', {leave: outsider})), p.ProtocolError);
  // Stale and future-dated requests are refused.
  code(() => f.leave(1, 1, f.now - 31 * 86400), 'invalid_request');
  code(() => f.leave(1, 1, f.now + 3600), 'invalid_request');
  assert.equal(f.list(0).items.length, 0, 'nothing was stored');
  // A different circle is refused.
  const wrong = p.signEnvelope('leave', {schema: 'faravan.leave.v1', circle: '33333333-3333-4333-8333-333333333333', key_id: fp[1], issued_at: iso(f.now)}, keys[1]);
  assert.throws(() => f.store.createLeaveRequest({leave: wrong}, f.ctx(1, 'POST', '/leave-requests', {leave: wrong})), p.ProtocolError);
  // Extra body fields are refused.
  const ok = p.signEnvelope('leave', {schema: 'faravan.leave.v1', circle, key_id: fp[1], issued_at: iso(f.now)}, keys[1]);
  assert.throws(() => f.store.createLeaveRequest({leave: ok, note: 'x'}, f.ctx(1, 'POST', '/leave-requests', {leave: ok, note: 'x'})), p.ProtocolError);
});

test('installing a roster without the device drops its request', t => {
  const f = fixture(t);
  f.leave(1);
  const members = roster.payload.members.filter(m => m.key_id !== fp[1]);
  const next = p.signEnvelope('roster', {...roster.payload, epoch: f.epoch + 1, members}, keys[2]);
  f.store.installRoster(next, f.ctx(0, 'PUT', '/roster', next, {roster_epoch: next.payload.epoch}));
  f.epoch = next.payload.epoch;
  assert.deepEqual(f.list(0).items, []);
  assert.throws(() => f.list(1), p.ProtocolError, 'the removed device is no longer a member');
});
