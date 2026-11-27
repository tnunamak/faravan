import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {hostEnrollmentsFor, joinRequest, joinTransport, reply} from './helpers/join-transport.mjs';

test('a malformed answer to a join the host applied leaves the join unknown, and the retry replays that join', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const sent = [];
  // The host applies the join, but the device receives an answer it cannot read: the enrollment has no state or key.
  const incomplete = ({status, text}) => reply({status, text: JSON.stringify({enrollment_id: JSON.parse(text).enrollment_id})});
  const owner = await f.start('owner', {autoApprove: false, pollMs: 250});
  await f.provisionFromHome('owner');
  const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Malformed answer'}});
  await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', body: {approveEach: true}});
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}});
  const lender = await f.start('lender', {autoApprove: false, pollMs: 60000, fetch: joinTransport(incomplete, sent)});
  const failed = await joinRequest(lender, invite);
  assert.ok(failed.status >= 400, 'a join whose answer cannot be read is not reported as joined');
  const intents = lender.app.device.intentStore(circle.id);
  assert.equal((await intents.get('join-enrollment'))?.outcome, 'unknown', 'the host may have applied the join, so it stays unknown');
  assert.equal((await lender.app.device.selectCircle(circle.id)).enrollment ?? null, null, 'no enrollment is recorded yet');

  await lender.app.device.resumeJoin(circle.id);
  assert.equal((await lender.app.device.selectCircle(circle.id)).enrollment?.state, 'pending', 'the retry records the host answer');
  assert.equal(await intents.get('join-enrollment'), null, 'the finished join clears its intent');
  assert.equal(sent.length, 2);
  assert.equal(sent[1].key, sent[0].key, 'the retry reuses the idempotency key');
  assert.equal(sent[1].body, sent[0].body, 'the retry sends the same body');
  assert.equal(hostEnrollmentsFor(f, circle.id, lender.app.device.keyId).length, 1, 'the host holds one enrollment for this device');
});
