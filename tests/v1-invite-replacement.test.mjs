import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture,api} from './helpers/v1-app-fixture.mjs';
import {json} from './helpers/v1-journey.mjs';

// A fresh invitation must reach the host even when the circle already holds an earlier enrollment that is no longer
// approved. The earlier enrollment keeps its own invitation until the new one is enrolled: a join that rewrites the
// circle's invitation first makes the old enrollment look like the new one's. Same root cause as v1-revoked-reenroll.
for (const hostState of ['expired', 'rejected']) {
  test(`a fresh invitation replaces an earlier ${hostState} enrollment and is enrolled exactly once`, {timeout: 60000}, async t => {
    const f = await appFixture(t);
    const enrollmentAnswers = new Map(), enrollPosts = [], previous = f.override;
    let lenderKeyId = null;
    f.override = async details => {
      const enrollmentId = details.route.match(/^\/enrollments\/([^/]+)$/)?.[1];
      if (enrollmentId && details.req.method === 'GET' && enrollmentAnswers.has(enrollmentId)) {
        json(details.res, {enrollment_id: enrollmentId, state: enrollmentAnswers.get(enrollmentId), device_key_id: lenderKeyId, roster: null});
        return true;
      }
      if (details.route === '/enrollments' && details.req.method === 'POST') enrollPosts.push(details.body.invite.payload.invite_id);
      return previous(details);
    };

    const owner = await f.start('owner', {autoApprove: false, pollMs: 250});
    await f.provisionFromHome('owner');
    const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Replacement invitation'}});
    await api(owner.app, '/api/circles/' + circle.id + '/approval-mode', {method: 'POST', body: {approveEach: true}});
    const invitationA = (await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}})).invite;
    // A long poll interval keeps the background sweep from adding enrollment requests during the assertions.
    const lender = await f.start('lender', {autoApprove: false, pollMs: 60000});
    lenderKeyId = lender.app.device.keyId;
    const joinedA = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: invitationA}});
    assert.equal(joinedA.enrollment.state, 'pending');
    const enrollmentA = joinedA.enrollment.enrollment_id;

    // The host answers the earlier enrollment with the state under test; the device records that answer itself.
    enrollmentAnswers.set(enrollmentA, hostState);
    await lender.app.device.refreshRoster(circle.id).catch(() => {});
    assert.equal((await lender.app.device.selectCircle(circle.id)).enrollment.state, hostState,
      'the circle holds the earlier enrollment');

    const invitationB = (await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}})).invite;
    const postsBefore = enrollPosts.length;
    const joinedB = await api(lender.app, '/api/circles/join', {method: 'POST', body: {link: invitationB}});
    assert.equal(enrollPosts.length - postsBefore, 1, 'the fresh invitation is enrolled exactly once');
    const stored = await lender.app.device.selectCircle(circle.id);
    assert.equal(joinedB.enrollment.state, 'pending', 'the result is the host answer for the fresh invitation');
    assert.notEqual(joinedB.enrollment.enrollment_id, enrollmentA, 'the result is not the earlier enrollment');
    assert.equal(stored.enrollment.enrollment_id, joinedB.enrollment.enrollment_id);
    assert.equal(stored.joinInfo.inviteId, enrollPosts.at(-1), 'the circle names the invitation it was enrolled with');
    assert.equal(await lender.app.device.intentStore(circle.id).get('join-enrollment'), null, 'the intent is finished');
  });
}
