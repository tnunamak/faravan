import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as p from '../lib/protocol/index.mjs';
import { appFixture, api, waitFor } from './helpers/v1-app-fixture.mjs';

const opts = {timeout: 120000};
const CIRCLE = '11111111-1111-4111-8111-111111111111';
const keyPair = () => { const k = generateKeyPairSync('ed25519'); return {...k, pub: p.exportPublicKey(k.publicKey), id: p.fingerprint(k.publicKey)}; };
const leavePayload = (key, extra = {}) => ({schema: 'faravan.leave.v1', circle: CIRCLE, key_id: key.id, issued_at: '2026-10-19T14:41:00Z', ...extra});
const memberIds = async (app, id) => (await app.device.rosterCache(id).get()).current.payload.members.map(m => m.key_id);

test('a leave request is signed by the leaving device, in its own domain', () => {
  const a = keyPair(), b = keyPair();
  const signed = p.signEnvelope('leave', leavePayload(a), a.privateKey);
  assert.equal(p.verifyEnvelope('leave', signed, a.pub).ok, true);
  assert.equal(p.verifyEnvelope('leave', signed, b.pub).ok, false, 'another key cannot stand in');
  assert.equal(p.verifyEnvelope('cancellation', signed, a.pub).ok, false, 'a leave signature is not a cancellation');
  assert.equal(p.verifyEnvelope('leave', {...signed, payload: {...signed.payload, issued_at: '2026-10-20T00:00:00Z'}}, a.pub).ok, false, 'the time is signed');
  assert.throws(() => p.signEnvelope('leave', leavePayload(b), a.privateKey), /key_mismatch/, 'a device signs only for itself');
  for (const bad of [{schema: 'faravan.leave.v2'}, {circle: 'nope'}, {issued_at: 'yesterday'}, {extra: 1}])
    assert.throws(() => p.signEnvelope('leave', leavePayload(a, bad), a.privateKey), undefined, JSON.stringify(bad));
});

// These use the real coordinator store and HTTP server (realConnect): owner, a declining member and a lender.
test('leaving a circle asks the owner, whose device removes it from the signed roster', opts, async t => {
  const f = await appFixture(t), {owner, lender, declining, circle} = await f.realConnect();
  const lenderKey = lender.app.device.keyId;
  assert.ok((await memberIds(owner.app, circle.id)).includes(lenderKey));
  const left = await api(lender.app, '/api/circles/' + circle.id + '/leave', {method: 'POST', body: {}});
  assert.deepEqual([left.left, left.leaveRequested, left.rosterMembershipUnchanged], [true, true, true]);
  assert.ok(!(await lender.app.device.listCircles()).some(c => c.id === circle.id), 'the device forgot the circle');
  // The roster still lists the device until the owner's device applies the request.
  assert.ok((await memberIds(owner.app, circle.id)).includes(lenderKey));
  const applied = await owner.app.device.applyLeaveRequests(circle.id);
  assert.deepEqual(applied.removed.map(x => x.key_id), [lenderKey]);
  const after = await memberIds(owner.app, circle.id);
  assert.ok(!after.includes(lenderKey), 'removed from the owner\'s signed roster');
  assert.ok(after.includes(owner.app.device.keyId) && after.includes(declining.app.device.keyId), 'everyone else stays');
  assert.deepEqual((await owner.app.device.applyLeaveRequests(circle.id)).removed, [], 'nothing left to apply');
  // The removed device can no longer use the circle: the coordinator fenced it.
  await declining.app.device.refreshRoster(circle.id);
  assert.ok(!(await memberIds(declining.app, circle.id)).includes(lenderKey), 'other members see the new roster');
});

test('the owner\'s background sweep applies it without a click, even in approve-each mode', opts, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.realConnect();
  await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', body: {approveEach: true}});
  await owner.app.close();
  const restarted = await f.start('owner', {autoApprove: true, approvalPollMs: 25, pollMs: 250});
  const lenderKey = lender.app.device.keyId;
  await api(lender.app, '/api/circles/' + circle.id + '/leave', {method: 'POST', body: {}});
  await waitFor(async () => !(await memberIds(restarted.app, circle.id)).includes(lenderKey), 'the sweep removed the leaver', 20000);
  const events = await api(restarted.app, '/api/activity');
  assert.ok(events.some(e => e.type === 'member-left' && e.data.circle === circle.id), 'the owner is told');
});

test('the coordinator keeps one request per device and drops it once the roster excludes the device', opts, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.realConnect();
  const client = await lender.app.device.client(circle.id);
  const first = await client.requestLeave();
  const again = await client.requestLeave();
  assert.equal(again.leave_id, first.leave_id, 'one open request per device');
  const ownerClient = await owner.app.device.client(circle.id);
  const items = await ownerClient.listLeaveRequests();
  assert.deepEqual(items.map(i => i.key_id), [lender.app.device.keyId]);
  const roster = (await owner.app.device.rosterCache(circle.id).get()).current.payload;
  const key = roster.members.find(m => m.key_id === items[0].key_id).public_key;
  assert.equal(p.verifyEnvelope('leave', items[0].leave, key).ok, true, 'the owner can verify it independently');
  await owner.app.device.applyLeaveRequests(circle.id);
  assert.deepEqual(await ownerClient.listLeaveRequests(), []);
});

test('an older coordinator without the route still lets the device leave locally', opts, async t => {
  const f = await appFixture(t), {lender, circle} = await f.connect({});
  const result = await lender.app.device.leaveCircle(circle.id);
  assert.deepEqual([result.left, result.leaveRequested, result.rosterMembershipUnchanged], [true, false, true]);
  assert.equal(typeof result.leaveError, 'string');
  assert.ok(!(await lender.app.device.listCircles()).some(c => c.id === circle.id), 'the device left locally anyway');
});

test('the worked example in the spec is the golden device signing a leave', () => {
  const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
  const spec = readFileSync(new URL('../docs/protocol/v1.md', import.meta.url), 'utf8');
  const block = [...spec.matchAll(/```json\n([\s\S]*?)\n```/g)].map(m => JSON.parse(m[1])).find(v => v.payload?.schema === 'faravan.leave.v1');
  const key = p.privateKeyFromSeed(Buffer.from(golden.keys[1].seed_hex, 'hex'));
  const rebuilt = p.signEnvelope('leave', {schema: 'faravan.leave.v1', circle: golden.objects.roster.envelope.payload.circle, key_id: golden.keys[1].fingerprint, issued_at: '2026-10-09T12:00:00Z'}, key);
  assert.equal(p.canonicalize(block), p.canonicalize(rebuilt), 'the documented bytes are reproducible from the fixed test seed');
  assert.equal(p.verifyEnvelope('leave', block, golden.keys[1].public_key).ok, true);
});
