import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveJobRecipient} from '../lib/v1/job-recipient.mjs';
import {appFixture, api, waitFor} from './helpers/v1-app-fixture.mjs';

// Bug: a circle whose host stopped answering stayed the default destination for new jobs, so Send was blocked
// (or a send went nowhere) until the person found and changed the circle by hand.
const approved = circle => ({origin: 'https://' + circle.id + '.test', enrollment: {state: 'approved'}, rosterMembershipVerified: true, ...circle});
const offline = (circle, lastReachedAt = '2026-11-04T15:12:00.000Z') => approved({...circle, host: {reachable: false, lastReachedAt}});

test('the default destination skips a circle whose host is known not to answer', () => {
  const circles = [offline({id: 'demo', name: 'Faravan demo', selected: true}), approved({id: 'friends', name: 'Friends'})];
  const resolved = resolveJobRecipient({}, circles);
  assert.equal(resolved.circle.id, 'friends');
  assert.equal(resolved.input.expected_default_circle, 'friends', 'consent binds the circle that is actually used');
});

test('a host not checked yet is not treated as offline', () => {
  const circles = [approved({id: 'demo', selected: true, host: {reachable: null, lastReachedAt: null}}), approved({id: 'friends'})];
  assert.equal(resolveJobRecipient({}, circles).circle.id, 'demo');
});

test('when every circle is offline there is no default: the refusal names the circle and when it last answered', () => {
  const circles = [offline({id: 'demo', name: 'Faravan demo', selected: true})];
  assert.throws(() => resolveJobRecipient({}, circles), error => error.code === 'circle_required' &&
    /Faravan demo/.test(error.message) && /isn.t answering/.test(error.message) && /2026-11-04T15:12/.test(error.message));
});

test('a person can still name an offline circle; only the default skips it', () => {
  const circles = [offline({id: 'demo', name: 'Faravan demo', selected: true}), approved({id: 'friends', name: 'Friends'})];
  assert.equal(resolveJobRecipient({circle: 'demo'}, circles).circle.id, 'demo');
});

test('a consented default that went offline before dispatch is refused as changed', () => {
  const circles = [offline({id: 'demo', name: 'Faravan demo', selected: true}), approved({id: 'friends', name: 'Friends'})];
  assert.throws(() => resolveJobRecipient({circle: 'demo', expected_circle_id: 'demo', expected_default_circle: 'demo'}, circles), {code: 'circle_changed'});
});

test('the circle list says which host does not answer, and a send with no circle goes to one that does', {timeout: 60000}, async t => {
  const f = await appFixture(t);
  const owner = await f.start('owner');
  await f.provisionFromHome('owner');
  const demo = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Faravan demo'}});
  const friends = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Friends'}});
  const before = await api(owner.app, '/api/circles');
  const stale = before.find(c => c.selected) ?? before.find(c => c.id === demo.id);
  const other = stale.id === demo.id ? friends : demo;
  // Listing circles reads each host not checked yet in the background; the next list has the answer.
  await waitFor(async () => (await api(owner.app, '/api/circles')).filter(c => c.origin).every(c => c.host?.reachable === true), 'both live hosts answered', 20000);

  // The stale circle's host goes away: every request for that circle now fails like a host that is down.
  const serve = f.override;
  f.override = async context => {
    if (context.circleId === stale.id) { context.res.writeHead(503); context.res.end(); return true; }
    return serve(context);
  };
  await api(owner.app, '/api/circles/' + encodeURIComponent(stale.id) + '/compose');
  const after = await waitFor(async () => {
    const list = await api(owner.app, '/api/circles');
    return list.find(c => c.id === stale.id).host?.reachable === false && list;
  }, 'the failed read marks the host offline', 20000);
  const row = after.find(c => c.id === stale.id);
  assert.ok(Number.isFinite(Date.parse(row.host.lastReachedAt)), 'an offline host says when it last answered');
  assert.notEqual(after.find(c => c.id === other.id).host?.reachable, false);

  const required = await api(owner.app, '/api/ops/jobs.submit', {method: 'POST', body: {prompt: 'Fix it', files: [{path: 'a.txt', base64: 'eA=='}]}, status: 428});
  assert.equal(required.confirmation_input.circle, other.id, 'the default destination is the circle whose host answers');
});
