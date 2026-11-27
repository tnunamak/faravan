import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appFixture, api } from './helpers/v1-app-fixture.mjs';
import { forgeries } from './helpers/v1-short-invite.mjs';
import * as p from '../lib/protocol/index.mjs';

// Local app + synthetic loopback coordinator only. The app previews and joins short links, verifying the
// invite binding first. TEST-ONLY keys; no browser, provider or real network.
const testOptions = {timeout: 30000};
async function ownerWithInvite(f) {
  const owner = await f.start('owner'), lender = await f.start('lender');
  await f.provisionFromHome('owner');
  const circle = await api(owner.app, '/api/circles', {method: 'POST', body: {origin: f.origin, name: 'Synthetic friends'}});
  const {invite} = await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}});
  return {owner, lender, circle, invite, code: p.decodeShortLink(invite).code};
}
const preview = (app, link, status = 200) => api(app, '/api/circles/join-preview', {method: 'POST', body: {link}, status});
const join = (app, link, status = 200) => api(app, '/api/circles/join', {method: 'POST', body: {link}, status});

test('the app creates a short invitation; preview shows the verified owner name, join enrolls', testOptions, async t => {
  const f = await appFixture(t), {lender, circle, invite, code} = await ownerWithInvite(f);
  assert.match(invite, /\/i\/[a-z2-7]{10}#[A-Za-z0-9_-]{43}$/);
  const published = f.publications.get(code);
  assert.ok(published.envelope.payload.owner_name, 'the owner device names itself in the signed invitation');
  const shown = await preview(lender.app, invite);
  assert.equal(shown.name, 'Synthetic friends');
  assert.equal(shown.ownerName, published.envelope.payload.owner_name);
  assert.equal(shown.origin, f.origin);
  assert.ok(!JSON.stringify(shown).includes(p.decodeShortLink(invite).seed), 'the preview never echoes the seed');
  assert.ok(!(await api(lender.app, '/api/circles')).some(c => c.id === circle.id), 'a preview joins nothing');
  assert.equal(f.circles.get(circle.id).enrollments.length, 0);
  const joined = await join(lender.app, invite);
  assert.equal(joined.id, circle.id);
  assert.equal(f.circles.get(circle.id).enrollments.length, 1);
  assert.equal(f.rawRequests.filter(r => r.url === '/v1/invites/' + code).length, 2, 'one lookup for the preview, one for the join');
  assert.ok(!JSON.stringify(f.rawRequests).includes(p.decodeShortLink(invite).seed));
});

test('invitations carry the owner\'s name: OS full name by default, then the name they set', testOptions, async t => {
  const f = await appFixture(t), {owner, lender, invite, code} = await ownerWithInvite(f);
  const {defaultOwnerName} = await import('../lib/v1/owner-name.mjs');
  const devices = await api(owner.app, '/api/devices');
  assert.equal(devices.ownerName, defaultOwnerName());
  assert.equal(f.publications.get(code).envelope.payload.owner_name, devices.ownerName);
  assert.equal((await preview(lender.app, invite)).ownerName, devices.ownerName);
  const saved = await api(owner.app, '/api/devices', {method: 'POST', body: {ownerName: '  Rowan\u0007 Vale '}});
  assert.equal(saved.ownerName, 'Rowan  Vale', 'control characters are cleaned like a device name');
  assert.equal(saved.name, devices.name, 'setting your name leaves the computer name alone');
  await api(owner.app, '/api/devices', {method: 'POST', body: {ownerName: ' '}, status: 400});
  const circle = (await api(owner.app, '/api/circles')).find(c => c.owned && c.origin);
  const next = (await api(owner.app, '/api/circles/' + circle.id + '/invite', {method: 'POST', body: {}})).invite;
  assert.equal((await preview(lender.app, next)).ownerName, 'Rowan  Vale');
});

test('attack regression: preview and join refuse a coordinator-forged root for a short link', testOptions, async t => {
  const f = await appFixture(t), {lender, circle, invite, code} = await ownerWithInvite(f);
  const real = structuredClone(f.publications.get(code));
  for (const {label, publication} of forgeries(real)) {
    f.publications.set(code, publication);
    for (const call of [preview, join]) {
      const refused = await call(lender.app, invite, 400);
      assert.equal(refused.code, 'invalid_invite', label);
    }
    assert.equal(f.circles.get(circle.id).enrollments.length, 0, label + ': nothing was enrolled');
    assert.ok(!(await api(lender.app, '/api/circles')).some(c => c.id === circle.id), label + ': nothing was pinned');
  }
  f.publications.set(code, real);
  assert.equal((await preview(lender.app, invite)).name, 'Synthetic friends');
});

test('short-link errors: expired, unknown and unreachable invitations have distinct app codes', testOptions, async t => {
  const f = await appFixture(t), {lender, invite, code} = await ownerWithInvite(f);
  const seed = p.decodeShortLink(invite).seed;
  assert.equal((await preview(lender.app, f.origin + '/i/abcde23456#' + seed, 400)).code, 'invalid_invite');
  const real = f.publications.get(code);
  f.publications.set(code, {...real, envelope: {...real.envelope, payload: {...real.envelope.payload, expires_at: '2020-01-01T00:00:00Z'}}});
  assert.equal((await preview(lender.app, invite, 400)).code, 'invitation_expired');
  f.publications.set(code, real);
  const unreachable = await preview(lender.app, 'http://127.0.0.1:1/i/' + code + '#' + seed, 502);
  assert.equal(unreachable.code, 'invite_unreachable');
  assert.equal((await preview(lender.app, 'https://queue.example/i/' + code + '#short', 400)).code, 'invalid_invite');
  assert.equal((await preview(lender.app, 'x'.repeat(16385), 400)).code, 'invalid_invite');
});
