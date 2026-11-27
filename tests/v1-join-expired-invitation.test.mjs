import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {hostEnrollmentsFor, joinRequest, joinTransport} from './helpers/join-transport.mjs';

test('an unknown join whose invitation expired while the host was away is replayed, and the host decides', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const sent = [];
  let now = 1_800_000_000;
  const clock = () => now;
  // The host applies the join, and the device never receives the answer.
  const lostAfterAcceptance = () => { throw new TypeError('synthetic response loss after host acceptance'); };
  const owner = await f.start('owner', {autoApprove: false, pollMs: 250, clock});
  await f.provisionFromHome('owner');
  const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Expired invitation'}});
  await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', body: {approveEach: true}});
  // Valid long enough to join, and expired before the device resumes.
  const expiresAt = now + 60;
  const invite = await owner.app.device.createInvite(circle.id, {expires_at: new Date(expiresAt * 1000).toISOString().replace('.000Z', 'Z')});
  const lender = await f.start('lender', {autoApprove: false, pollMs: 60000,
    clock, clientOptions: {retry: {maxAttempts: 1}}, fetch: joinTransport(lostAfterAcceptance, sent, 'lender')});
  const failed = await joinRequest(lender, invite);
  assert.ok(failed.status >= 400, 'the answer was lost, so the join is not reported as joined');
  const intents = lender.app.device.intentStore(circle.id);
  assert.equal((await intents.get('join-enrollment'))?.outcome, 'unknown', 'the host may have applied the join');
  now = expiresAt + 1;

  await lender.app.device.resumeJoin(circle.id);
  assert.equal((await lender.app.device.selectCircle(circle.id)).enrollment?.state, 'pending',
    'the saved join reaches the host after its invitation expired');
  assert.equal(await intents.get('join-enrollment'), null, 'the finished join clears its intent');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].key, sent[0].key, 'the replay reuses the idempotency key');
  assert.equal(sent[1].body, sent[0].body, 'the replay sends the same body');
  assert.equal(hostEnrollmentsFor(f, circle.id, lender.app.device.keyId).length, 1, 'the host holds one enrollment for this device');
});
