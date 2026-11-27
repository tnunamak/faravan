import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api} from './helpers/v1-app-fixture.mjs';

const options = {timeout:60000};
const gitInput = circle => ({circle:circle.id, git:'https://github.com/example/synthetic.git',
  commit:'1'.repeat(40), prompt:'Pending enrollment jobs regression', harness:'codex'});

test('pending enrollment does not block global joined-circle jobs, while pending scope stays unavailable', options, async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner', {autoApprove:false});
  const lender = await f.start('lender', {joinWaitMs:0});
  await f.provisionFromHome('owner');
  await api(lender.app, '/api/devices', {method:'POST', body:{name:'Pending test device'}});

  const joinedCircle = await api(owner.app, '/api/circles', {method:'POST', body:{origin:f.origin, name:'Joined circle'}});
  const joinedInvite = (await api(owner.app, '/api/circles/' + joinedCircle.id + '/invite', {method:'POST', body:{}})).invite;
  const firstJoin = await api(lender.app, '/api/circles/join', {method:'POST', body:{link:joinedInvite}});
  assert.equal(firstJoin.enrollment.state, 'pending');
  await api(owner.app, '/api/circles/' + joinedCircle.id + '/approve', {method:'POST', body:{enrollmentId:firstJoin.enrollment.enrollment_id}});
  await lender.app.device.refreshRoster(joinedCircle.id);
  const submitted = await api(lender.app, '/api/jobs', {method:'POST', body:gitInput(joinedCircle)});

  const pendingCircle = await api(owner.app, '/api/circles', {method:'POST', body:{origin:f.origin, name:'Pending circle'}});
  const pendingInvite = (await api(owner.app, '/api/circles/' + pendingCircle.id + '/invite', {method:'POST', body:{}})).invite;
  const pendingJoin = await api(lender.app, '/api/circles/join', {method:'POST', body:{link:pendingInvite}});
  assert.equal(pendingJoin.enrollment.state, 'pending');

  const rows = await api(lender.app, '/api/jobs');
  assert.ok(rows.some(row => row.job_digest === submitted.jobDigest), 'global jobs keeps returning work from an already joined circle');

  const scoped = await api(lender.app, '/api/jobs?circle=' + encodeURIComponent(pendingCircle.id), {status:409});
  assert.equal(scoped.code, 'enrollment_pending', 'an explicitly requested pending-circle scope still reports enrollment pending');
});
