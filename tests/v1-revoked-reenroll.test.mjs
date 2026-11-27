import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as p from '../lib/protocol/index.mjs';
import { appFixture, api, boundedFetch, waitFor } from './helpers/v1-app-fixture.mjs';
import { resolveJoinLink } from '../lib/v1/short-invite.mjs';

// Review 2026-10-19: a revoked device key could enroll again through a fresh invite; the owner then signed a roster
// containing it, the coordinator refused that roster for good, and the owner's saved publication was retried forever.
// These use the real coordinator store (realConnect).
const memberIds = async (app, id) => (await app.device.rosterCache(id).get()).current.payload.members.map(m => m.key_id);
const invite = async (owner, circle) => (await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}})).invite;

test('a device the owner removed cannot enroll again through a fresh invite, and is told why', {timeout: 120000}, async t => {
  const f = await appFixture(t), {owner, lender, circle, realRequests} = await f.realConnect();
  const lenderKey = lender.app.device.keyId;
  const enrollmentPosts = () => realRequests.filter(r => r.device === lenderKey && r.route.endsWith('/enrollments')).length;
  await owner.app.device.removeMember(circle.id, lenderKey);
  assert.ok(!(await memberIds(owner.app, circle.id)).includes(lenderKey));
  const beforeInvite = enrollmentPosts();
  const link = await invite(owner, circle);
  const refused = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link}, status: 403});
  assert.equal(refused.code, 'device_removed');
  assert.match(refused.message, /removed/i);
  assert.equal(enrollmentPosts(), beforeInvite + 1, 'the fresh invite reaches the host');
  // Nothing was queued for the owner to approve.
  assert.deepEqual(await api(owner.app, '/api/circles/' + circle.id + '/approvals'), []);
});

test('a saved fresh invite for an enrolled revoked device reaches the host after restart', {timeout: 120000}, async t => {
  const f = await appFixture(t), {owner, lender, circle, realRequests} = await f.realConnect();
  const lenderKey = lender.app.device.keyId;
  const enrollmentPosts = () => realRequests.filter(r => r.device === lenderKey && r.route.endsWith('/enrollments')).length;
  const previous = (await lender.app.device.listCircles()).find(item => item.id === circle.id);
  await owner.app.device.removeMember(circle.id, lenderKey);
  assert.ok(!(await memberIds(owner.app, circle.id)).includes(lenderKey));

  const link = await invite(owner, circle);
  const fullInvite = await resolveJoinLink(link, {fetch: boundedFetch});
  const decoded = p.decodeInviteLink(fullInvite);
  assert.equal(decoded.ok, true);
  const payload = decoded.invite.payload;
  const beforeRestart = enrollmentPosts();
  await lender.app.device.intentStore(circle.id).set('join-enrollment', {
    kind: 'join-enrollment', invite: fullInvite, inviteId: payload.invite_id,
    idempotencyKey: payload.invite_id + '-' + lenderKey.slice(7, 23),
    createdAt: new Date().toISOString(), lastAttemptAt: null, outcome: 'unknown',
    joinInfo: {inviteId: payload.invite_id, approval: payload.approval === 'each' ? 'each' : 'automatic',
      ownerName: payload.owner_name ?? null, code: lender.app.device.matchCode(lenderKey), role: payload.role ?? 'lend'},
    deviceName: 'Lender laptop',
  });
  await lender.app.close();

  const restarted = await f.start('lender', {pollMs: 250});
  const recoveredStore = restarted.app.device.intentStore(circle.id);
  await waitFor(async () => {
    const saved = await recoveredStore.get('join-enrollment');
    const requests = enrollmentPosts();
    return !saved || requests > beforeRestart && saved.outcome === 'not_applied' ? {requests, saved} : null;
  }, 'startup recovery sends the new invite or takes the old-enrollment shortcut');

  assert.equal(enrollmentPosts(), beforeRestart + 1, 'startup recovery reaches the host');
  const saved = await recoveredStore.get('join-enrollment');
  assert.equal(saved.outcome, 'not_applied', 'the host reports that the revoked device cannot rejoin');
  const current = await restarted.app.device.selectCircle(circle.id);
  assert.equal(current.joinInfo.inviteId, previous.joinInfo.inviteId, 'the old enrollment keeps its invitation metadata');
  assert.equal(current.joinIntent.outcome, 'not_applied');
});

test('an enrollment queued before the removal is declined when the coordinator refuses its roster, and the owner is not wedged', {timeout: 120000}, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.realConnect();
  const lenderKey = lender.app.device.keyId;
  // The lender, still a member, redeems another invite (an enrollment waits at the coordinator).
  await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: await invite(owner, circle)}});
  await owner.app.device.removeMember(circle.id, lenderKey);
  // The coordinator refuses a roster that lists the removed key. That must not wedge the owner or repeat on every approve.
  const result = await api(owner.app, '/api/circles/' + circle.id + '/approve', {method: 'POST', body: {}});
  assert.ok(!(await memberIds(owner.app, circle.id)).includes(lenderKey));
  assert.deepEqual(result.approved, []);
  assert.deepEqual(result.rejected.map(r => r.code), ['device_removed']);
  assert.deepEqual(await api(owner.app, '/api/circles/' + circle.id + '/approvals'), [], 'the removed device no longer waits for approval');
  await owner.app.device.refreshRoster(circle.id);
  const next = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}});
  assert.ok(next.invite, 'the owner can still invite');
});

test('a roster publication the coordinator definitively refuses is dropped, so it cannot block every later refresh', {timeout: 120000}, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.realConnect();
  await owner.app.close();
  // This coordinator refuses every roster publication with a definitive "not applied" answer.
  let publishAttempts = 0;
  const refusing = async (url, init) => {
    if (init?.method === 'PUT' && new URL(url).pathname.endsWith('/roster')) {
      publishAttempts++;
      return new Response(p.canonicalize({type: 'urn:faravan:problem:forbidden', title: 'forbidden', status: 403, code: 'forbidden', retryable: false, outcome: 'not_applied'}),
        {status: 403, headers: {'content-type': 'application/problem+json'}});
    }
    return boundedFetch(url, init);
  };
  const restarted = await f.start('owner', {fetch: refusing, pollMs: 250});
  const store = restarted.app.device.intentStore(circle.id);
  await assert.rejects(restarted.app.device.removeMember(circle.id, lender.app.device.keyId), e => e.code === 'forbidden', 'the first attempt reports the refusal');
  assert.equal(await store.get('roster-publication'), null, 'a refused publication is not saved to be retried forever');
  const attempts = publishAttempts;
  await restarted.app.device.refreshRoster(circle.id); // later refreshes work and do not resend the refused roster
  assert.equal(publishAttempts, attempts);
});

test('an uncertain publication outcome is still kept and retried', {timeout: 120000}, async t => {
  const f = await appFixture(t), {owner, lender, circle} = await f.realConnect();
  await owner.app.close();
  let fail = true;
  const flaky = async (url, init) => {
    if (fail && init?.method === 'PUT' && new URL(url).pathname.endsWith('/roster')) throw Object.assign(new Error('network down'), {code: 'ECONNRESET'});
    return boundedFetch(url, init);
  };
  const restarted = await f.start('owner', {fetch: flaky, pollMs: 250});
  const lenderKey = lender.app.device.keyId;
  await assert.rejects(restarted.app.device.removeMember(circle.id, lenderKey));
  assert.ok(await restarted.app.device.intentStore(circle.id).get('roster-publication'), 'unknown outcome: the publication is kept');
  fail = false;
  await restarted.app.device.refreshRoster(circle.id);
  assert.ok(!(await memberIds(restarted.app, circle.id)).includes(lenderKey), 'and the retry applied it');
});
