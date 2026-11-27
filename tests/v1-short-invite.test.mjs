import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import { openV1Store } from '../lib/v1/store.mjs';
import { createV1Handler } from '../lib/v1/server.mjs';
import { createClient } from '../lib/v1/client.mjs';
import { classifyJoinInput, resolveJoinLink } from '../lib/v1/short-invite.mjs';
import { realCoordinator, forgeries } from './helpers/v1-short-invite.mjs';

// Hermetic loopback only: a real SQLite store and HTTP handler, real devices, TEST-ONLY keys. No browser,
// provider, Docker or external network.
const golden = JSON.parse(readFileSync(new URL('../docs/protocol/vectors/golden.json', import.meta.url)));
const keys = golden.keys.map(k => p.privateKeyFromSeed(Buffer.from(k.seed_hex, 'hex')));
const pubs = keys.map(p.exportPublicKey), ids = pubs.map(p.fingerprint);
const vectors = Object.fromEntries(Object.entries(golden.objects).map(([k, v]) => [k, v.envelope]));
const circle = vectors.job.payload.circle;
const start = Date.parse('2026-10-09T12:00:00Z') / 1000;
const iso = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
const secrets = seed => [seed, Buffer.from(seed, 'base64url').toString('hex'), Buffer.from(seed, 'base64url').toString('base64')];
const dump = list => JSON.stringify(list);
const problemOf = async (response, status, code) => {
  assert.equal(response.status, status, response.text);
  assert.match(response.headers.get('content-type'), /^application\/problem\+json/);
  assert.equal(JSON.parse(response.text).code, code);
};

// --- Publication and resolution against the store and HTTP handler, signed with the golden keys ---------

async function goldenFixture(t, {limits} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-short-invite-http-'));
  let now = start, store, handler;
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  const open = () => {
    store = openV1Store({path: join(dir, 'store.sqlite'), origin, circle, rootFingerprint: ids[2],
      initialRoster: vectors.roster, clock: () => now});
    handler = createV1Handler({store, blobDir: join(dir, 'blobs'), clock: () => now, limits});
  };
  open();
  t.after(async () => {
    handler.close(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(dir, {recursive: true, force: true});
  });
  const f = {origin, get now() { return now; }, advance(n) { now += n; },
    restart() { handler.close(); store.close(); open(); },
    invite(overrides = {}, root = keys[2]) {
      return p.createInvite({circle, coordinator: origin, invite_id: randomUUID(), invite_public_key: pubs[3],
        created_at: iso(now), expires_at: iso(now + 3600), display_name: 'Critics', owner_name: 'Tessa', ...overrides}, root);
    },
    publication(invite = f.invite(), code = p.generateInviteCode(), binding = p.createInviteBinding(invite, keys[3])) {
      return {code, envelope: invite, invite_binding: binding};
    },
    async post(body, {signer = 0, withProof = true} = {}) {
      const bytes = Buffer.from(p.canonicalize(body)), key = randomUUID();
      const headers = {'Content-Type': 'application/json', 'Content-Length': String(bytes.length), 'Idempotency-Key': key};
      if (withProof) headers['Faravan-Proof'] = p.buildRequestProof({circle, roster_epoch: vectors.roster.payload.epoch,
        method: 'POST', target: origin + '/v1/circles/' + circle + '/invites', body: bytes, content_type: 'application/json',
        artifact_media_type: '', idempotency_key: key, created: now, nonce: randomBytes(24).toString('base64url')}, keys[signer]);
      const response = await fetch(origin + '/v1/circles/' + circle + '/invites', {method: 'POST', headers, body: bytes});
      return {status: response.status, headers: response.headers, text: await response.text()};
    },
    async get(code, init) {
      const response = await fetch(origin + '/v1/invites/' + code, init);
      return {status: response.status, headers: response.headers, text: await response.text()};
    },
  };
  return f;
}

test('a published invite resolves publicly to exactly its public envelope and binding', async t => {
  const f = await goldenFixture(t), pub = f.publication();
  const stored = await f.post(pub);
  assert.equal(stored.status, 200, stored.text);
  assert.equal(stored.text, p.canonicalize(pub));
  const got = await f.get(pub.code);
  assert.equal(got.status, 200);
  assert.equal(got.text, p.canonicalize({envelope: pub.envelope, invite_binding: pub.invite_binding}));
  assert.equal(got.headers.get('cache-control'), 'no-store');
  assert.match(got.headers.get('content-type'), /^application\/json/);
  // Public: no proof header was sent, and the answer carries no secret or request-specific field.
  assert.deepEqual(Object.keys(JSON.parse(got.text)).sort(), ['envelope', 'invite_binding']);
  assert.equal(p.inviteLinkFromPublication(JSON.parse(got.text), {coordinator: f.origin, seed: Buffer.alloc(32, 4).toString('base64url')}).ok, true);
});

test('resolve answers 404 for unknown or malformed codes and 410 once the invite has expired', async t => {
  const f = await goldenFixture(t), pub = f.publication();
  assert.equal((await f.post(pub)).status, 200);
  await problemOf(await f.get(p.generateInviteCode()), 404, 'not_found');
  for (const bad of ['ABCDEFGHIJ', 'abc', 'a'.repeat(11), 'abcde-fghi', 'abcdefghi1', pub.code + '%2e', pub.code + '?x=1'])
    await problemOf(await f.get(bad), 404, 'not_found');
  assert.equal((await f.get(pub.code)).status, 200);
  f.advance(3599);
  assert.equal((await f.get(pub.code)).status, 200);
  f.advance(1);
  await problemOf(await f.get(pub.code), 410, 'enrollment_expired');
});

test('public resolution has its own per-code limit that clears with time and never blocks signed traffic', async t => {
  const f = await goldenFixture(t, {limits: {inviteLookupsPerSource: 3, inviteLookupWindowSeconds: 60}}), pub = f.publication();
  assert.equal((await f.post(pub)).status, 200);
  for (let n = 0; n < 3; n++) assert.equal((await f.get(pub.code)).status, 200);
  const limited = await f.get(pub.code);
  await problemOf(limited, 429, 'rate_limited');
  assert.equal(limited.headers.get('retry-after'), '1');
  assert.equal((await f.post(f.publication())).status, 200, 'enrollment traffic has a separate window');
  f.advance(60);
  assert.equal((await f.get(pub.code)).status, 200);
});

test('publication needs a current member and a valid, correctly bound invite', async t => {
  const f = await goldenFixture(t);
  const unauth = await f.post(f.publication(), {withProof: false});
  await problemOf(unauth, 401, 'unauthenticated');
  await problemOf(await f.post(f.publication(), {signer: 3}), 403, 'forbidden'); // not in the roster
  // Another circle, an expired invite and a root the server did not pin never become resolvable.
  const rejected = [
    [f.publication(f.invite({circle: vectors.job.payload.intent_id})), 400, 'wrong_circle'],
    [f.publication(f.invite({created_at: iso(f.now - 7200), expires_at: iso(f.now - 3600)})), 410, 'enrollment_expired'],
    [f.publication(f.invite({}, keys[1])), null, null],
  ];
  for (const [pub, status, code] of rejected) {
    const r = await f.post(pub);
    assert.ok(r.status >= 400, r.text);
    if (status) await problemOf(r, status, code);
    await problemOf(await f.get(pub.code), 404, 'not_found');
  }
});

test('publication refuses a binding the invite key did not make and malformed bodies', async t => {
  const f = await goldenFixture(t), invite = f.invite();
  const other = f.invite();
  const cases = [
    ['binding made over a different envelope', f.publication(invite, undefined, p.createInviteBinding(other, keys[3]))],
    ['binding from the wrong key', f.publication(invite, undefined, {...p.createInviteBinding(invite, keys[3]),
      value: Buffer.from(p.createInviteBinding(f.invite({invite_public_key: pubs[0]}), keys[0]).value, 'base64url').toString('base64url')})],
    ['binding with a bad length', f.publication(invite, undefined, {...p.createInviteBinding(invite, keys[3]), value: 'AAAA'})],
    ['uppercase code', {...f.publication(invite), code: 'ABCDEFGHIJ'}],
    ['short code', {...f.publication(invite), code: 'abcde'}],
    ['extra member', {...f.publication(invite), extra: true}],
    ['missing binding', (({invite_binding, ...rest}) => rest)(f.publication(invite))],
    ['oversized publication', f.publication(f.invite({display_name: 'x'.repeat(256), owner_name: 'y'.repeat(64)}), undefined)],
  ];
  for (const [label, body] of cases) {
    const r = await f.post(body);
    if (label === 'oversized publication') { assert.equal(r.status, 200, 'the largest legal invite fits the bound'); continue; }
    assert.ok(r.status >= 400, label + ': ' + r.text);
    await problemOf(await f.get(body.code ?? 'abcdefghij'), 404, 'not_found');
  }
  // A body that is nothing like an invite or a publication.
  assert.ok((await f.post({code: 'abcdefghij', envelope: 7, invite_binding: 7})).status >= 400);
  assert.ok((await f.post({payload: {}, signature: {}})).status >= 400);
});

test('publication is idempotent by invite_id; conflicting code, binding or envelope are refused', async t => {
  const f = await goldenFixture(t), pub = f.publication();
  assert.equal((await f.post(pub)).status, 200);
  const again = await f.post(pub);
  assert.equal(again.status, 200);
  assert.equal(again.text, p.canonicalize(pub));
  await problemOf(await f.post({...pub, code: p.generateInviteCode()}), 409, 'enrollment_conflict');
  const rival = f.publication(f.invite(), pub.code); // another invite asking for a taken code
  await problemOf(await f.post(rival), 409, 'conflict');
  assert.equal(JSON.parse((await f.get(pub.code)).text).envelope.payload.invite_id, pub.envelope.payload.invite_id);
  // The same invite_id with different bytes (a changed owner name) is refused, never replaced.
  const changed = f.publication(f.invite({invite_id: pub.envelope.payload.invite_id, owner_name: 'Mallory'}));
  await problemOf(await f.post(changed), 409, 'enrollment_conflict');
  assert.equal(JSON.parse((await f.get(pub.code)).text).envelope.payload.owner_name, 'Tessa');
});

test('a bare legacy invite still registers, has no code, and can be upgraded to a publication', async t => {
  const f = await goldenFixture(t), invite = f.invite(), code = p.generateInviteCode();
  const legacy = await f.post(invite);
  assert.equal(legacy.status, 200);
  assert.equal(legacy.text, p.canonicalize(invite));
  await problemOf(await f.get(code), 404, 'not_found');
  assert.equal((await f.post(f.publication(invite, code))).status, 200);
  assert.equal((await f.get(code)).status, 200);
});

test('published invites survive a coordinator restart', async t => {
  const f = await goldenFixture(t), pub = f.publication();
  assert.equal((await f.post(pub)).status, 200);
  f.restart();
  const got = await f.get(pub.code);
  assert.equal(got.status, 200);
  assert.equal(got.text, p.canonicalize({envelope: pub.envelope, invite_binding: pub.invite_binding}));
  assert.equal((await f.post(pub)).status, 200, 'republishing after restart is still a no-op');
  f.restart();
  f.advance(3600);
  await problemOf(await f.get(pub.code), 410, 'enrollment_expired');
});

test('the client verifies the binding before it publishes', async t => {
  const f = await goldenFixture(t);
  const snapshot = {current: vectors.roster, history: [], highestAcceptedEpoch: vectors.roster.payload.epoch,
    highestAcceptedDigest: p.digest(vectors.roster.payload)};
  const client = createClient({origin: f.origin, circle, deviceKey: keys[0], pinnedRootFingerprint: ids[2],
    rosterCache: {get: async () => snapshot, set: async () => {}}, clock: () => f.now, retry: {maxAttempts: 1}});
  const invite = f.invite();
  await assert.rejects(client.publishInvite({code: p.generateInviteCode(), invite, binding: p.createInviteBinding(f.invite(), keys[3])}),
    e => e.code === 'invalid_signature');
  const code = p.generateInviteCode(), stored = await client.publishInvite({code, invite, binding: p.createInviteBinding(invite, keys[3])});
  assert.equal(stored.code, code);
});

// --- Real devices over real HTTP -------------------------------------------------------------------------

test('short-link journey: owner publishes, joiner resolves, verifies and enrolls; the seed never reaches the server', async t => {
  const c = await realCoordinator(t);
  const links = await c.owner.createInviteLinks(c.circle.id, {ownerName: 'Tessa'});
  assert.equal(links.note, null);
  const decoded = p.decodeShortLink(links.short);
  assert.equal(decoded.ok, true);
  assert.ok(links.short.length < 100 && links.long.length > 700);
  assert.equal(await c.owner.createInvite(c.circle.id) !== links.short, true, 'each invite is fresh');

  const joiner = await c.device('joiner');
  const before = c.seen.length;
  const joined = await joiner.joinCircle(links.short, {deviceName: 'Laptop'});
  assert.equal(joined.id, c.circle.id);
  assert.equal(joined.pinnedRootFingerprint, c.circle.pinnedRootFingerprint);
  assert.equal(joined.joinInfo.ownerName, 'Tessa');
  assert.equal(joined.enrollment.state, 'pending');
  const lookups = c.seen.slice(before).filter(r => r.url.startsWith('/v1/invites/'));
  assert.deepEqual(lookups.map(r => r.url), ['/v1/invites/' + decoded.code]);
  assert.equal(lookups[0].headers['faravan-proof'], undefined, 'resolution is unauthenticated');
  assert.equal((await c.owner.approveEnrollments(c.circle.id)).approved.length, 1);
  await joiner.awaitApproval(c.circle.id, {timeoutMs: 2000});
  assert.equal((await joiner.listCircles()).find(x => x.id === c.circle.id).enrollment.state, 'approved');

  // Secrecy: nothing the server received, and nothing any client sent, holds the seed in any encoding.
  for (const secret of secrets(decoded.seed)) {
    assert.ok(!dump(c.seen).includes(secret), 'server saw the seed');
    assert.ok(!dump(c.sent).includes(secret), 'a client sent the seed');
  }
  assert.ok(!dump(c.seen).includes(links.short.slice(links.short.indexOf('#'))), 'the fragment is never requested');
  assert.ok(c.seen.every(r => !r.url.includes('#')));
});

test('the long link still joins on the same server', async t => {
  const c = await realCoordinator(t);
  const links = await c.owner.createInviteLinks(c.circle.id, {ownerName: 'Tessa'});
  const joiner = await c.device('joiner');
  const before = c.seen.length;
  const joined = await joiner.joinCircle(links.long, {deviceName: 'Laptop'});
  assert.equal(joined.enrollment.state, 'pending');
  assert.ok(c.seen.slice(before).every(r => !r.url.startsWith('/v1/invites/')), 'a long link needs no lookup');
  const raw = (await c.owner.createInviteLinks(c.circle.id)).long;
  const second = await c.device('joiner-raw');
  assert.equal((await second.joinCircle(raw.slice(raw.indexOf('=') + 1), {deviceName: 'Raw blob'})).enrollment.state, 'pending');
});

test('a server without publication support falls back to the long link and says so', async t => {
  const c = await realCoordinator(t);
  c.refusePublication = true;
  const links = await c.owner.createInviteLinks(c.circle.id, {ownerName: 'Tessa'});
  assert.equal(links.short, null);
  assert.match(links.note, /long link/);
  assert.match(await c.owner.createInvite(c.circle.id), /\/join#invite=/, 'createInvite returns the long link when nothing shorter exists');
  const joiner = await c.device('joiner');
  assert.equal((await joiner.joinCircle(links.long, {deviceName: 'Laptop'})).enrollment.state, 'pending');
});

test('attack regression: a coordinator that swaps in its own root is refused by the joiner', async t => {
  const c = await realCoordinator(t);
  const links = await c.owner.createInviteLinks(c.circle.id, {ownerName: 'Tessa'});
  const {code, seed} = p.decodeShortLink(links.short);
  const real = JSON.parse((await c.get('/v1/invites/' + code)).text);
  for (const {label, publication} of forgeries(real)) {
    if (publication.envelope !== real.envelope) {
      // Round-1 design: only the seed-to-key check. It accepts the forgery and would pin the attacker's root.
      const naive = p.decodeInviteLink(p.encodeInviteLink(publication.envelope, seed));
      assert.equal(naive.ok, true, label + ': the seed check alone cannot tell');
      assert.notEqual(naive.invite.payload.root_fingerprint, c.circle.pinnedRootFingerprint);
    }
    c.override = (req, res) => {
      if (req.url !== '/v1/invites/' + code) return false;
      const body = Buffer.from(p.canonicalize(publication));
      res.writeHead(200, {'content-type': 'application/json', 'content-length': body.length}); res.end(body);
      return true;
    };
    const joiner = await c.device('joiner-' + Math.random().toString(36).slice(2));
    const before = c.seen.length;
    await assert.rejects(joiner.joinCircle(links.short, {deviceName: 'Laptop'}), e => e.code === 'invite_binding_invalid', label);
    assert.deepEqual((await joiner.listCircles()).filter(x => x.id === c.circle.id), [], label + ': nothing was pinned');
    assert.ok(c.seen.slice(before).every(r => r.method !== 'POST'), label + ': no enrollment was sent');
  }
  c.override = null;
  assert.equal((await (await c.device('joiner-honest')).joinCircle(links.short, {deviceName: 'Laptop'})).enrollment.state, 'pending');
});

test('resolution refuses an origin mismatch, an oversized or redirected answer and a dead server', async t => {
  const c = await realCoordinator(t);
  const links = await c.owner.createInviteLinks(c.circle.id, {ownerName: 'Tessa'});
  const {code, seed} = p.decodeShortLink(links.short);
  // The same code and seed presented under another origin cannot be resolved there.
  const elsewhere = createServer((req, res) => { res.writeHead(200, {'content-type': 'application/json'}); res.end('{"x":"' + 'a'.repeat(20000) + '"}'); });
  elsewhere.listen(0, '127.0.0.1'); await once(elsewhere, 'listening');
  t.after(() => new Promise(resolve => { elsewhere.closeAllConnections(); elsewhere.close(resolve); }));
  const bad = 'http://127.0.0.1:' + elsewhere.address().port + '/i/' + code + '#' + seed;
  await assert.rejects(resolveJoinLink(bad), e => e.code === 'payload_too_large');
  const redirect = createServer((req, res) => { res.writeHead(302, {location: c.origin + req.url}); res.end(); });
  redirect.listen(0, '127.0.0.1'); await once(redirect, 'listening');
  t.after(() => new Promise(resolve => { redirect.closeAllConnections(); redirect.close(resolve); }));
  await assert.rejects(resolveJoinLink('http://127.0.0.1:' + redirect.address().port + '/i/' + code + '#' + seed), e => e.code === 'network_error');
  await assert.rejects(resolveJoinLink('http://127.0.0.1:1/i/' + code + '#' + seed), e => e.code === 'network_error');
  await assert.rejects(resolveJoinLink(c.origin + '/i/' + p.generateInviteCode() + '#' + seed), e => e.code === 'invite_not_found' && e.status === 404);
  // The right code with someone else's seed is a key mismatch, not a join.
  await assert.rejects(resolveJoinLink(c.origin + '/i/' + code + '#' + randomBytes(32).toString('base64url')), e => e.code === 'invite_binding_invalid');
});

test('join input forms: short, long, bare blob and the faravan:// wrapper; junk is refused before any request', () => {
  const short = 'https://queue.example/i/abcde23456#' + Buffer.alloc(32, 7).toString('base64url');
  assert.deepEqual(classifyJoinInput(short), {kind: 'short', link: short});
  assert.deepEqual(classifyJoinInput('  ' + short + '\n'), {kind: 'short', link: short});
  assert.deepEqual(classifyJoinInput('faravan://join?link=' + encodeURIComponent(short)), {kind: 'short', link: short});
  const long = golden.invite_link;
  assert.deepEqual(classifyJoinInput(long), {kind: 'long', link: long});
  assert.deepEqual(classifyJoinInput('faravan://join?link=' + encodeURIComponent(long)), {kind: 'long', link: long});
  const blob = long.slice(long.indexOf('=') + 1);
  assert.deepEqual(classifyJoinInput(blob), {kind: 'long', link: long});
  assert.deepEqual(classifyJoinInput('invite=' + blob), {kind: 'long', link: long});
  assert.deepEqual(classifyJoinInput('#invite=' + blob), {kind: 'long', link: long});
  for (const junk of ['', '   ', 'hello', 'faravan://join', 'faravan://join?link=', 'faravan://join?link=x&link=y', 'faravan://other?link=' + encodeURIComponent(short),
    'https://queue.example/other', 'https://queue.example/i/', 'ftp://queue.example/i/abcde23456#x', 'a'.repeat(70000), 'AAAA'.repeat(30)])
    assert.throws(() => classifyJoinInput(junk), e => e.code === 'invalid_invite_link', junk.slice(0, 40));
});

test('the coordinator process routes /i/<code> and /v1/invites/<code> to the v1 handler', async t => {
  const {startCoordinator} = await import('../lib/coordinator.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'faravan-short-invite-coordinator-')), dbPath = join(dir, 'v1.sqlite');
  const origin = 'https://coordinator.example';
  const provisioned = openV1Store({path: dbPath, origin, circle, rootFingerprint: ids[2], initialRoster: vectors.roster, clock: () => start});
  provisioned.close();
  const server = await startCoordinator({dataDir: join(dir, 'v0'), port: 0, v1: {dbPath, blobDir: join(dir, 'blobs'), origin}});
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(dir, {recursive: true, force: true}); });
  const bound = 'http://127.0.0.1:' + server.address().port;
  const page = await fetch(bound + '/i/abcde23456');
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.equal(await page.text(), readFileSync(new URL('../public/join/index.html', import.meta.url), 'utf8'));
  assert.match((await fetch(bound + '/join')).headers.get('content-security-policy'), /connect-src 'none'/);
  assert.equal((await fetch(bound + '/i/not-a-code')).status, 404);
  const missing = await fetch(bound + '/v1/invites/abcde23456');
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).code, 'not_found');
});


test('optional invite metadata preserves old vectors and signs new role/use vectors', async t => {
  const f = await goldenFixture(t);
  const old = f.invite(), fields = old.payload;
  assert.equal(Object.hasOwn(fields, 'role'), false);
  assert.equal(Object.hasOwn(fields, 'max_uses'), false);
  assert.deepEqual(p.createInvite(fields, keys[2]), old, 'legacy signed bytes stay identical');
  for (const role of ['borrow', 'lend', 'both']) {
    const next = f.invite({...fields, role, max_uses: 2});
    assert.equal(p.verifyEnvelope('invite', next, pubs[2]).ok, true);
    assert.equal(next.payload.role, role);
    assert.equal(next.payload.max_uses, 2);
    const link = p.encodeInviteLink(next, Buffer.alloc(32, 4));
    assert.deepEqual(p.decodeInviteLink(link).invite, next);
    for (const change of [{role: role === 'borrow' ? 'lend' : 'borrow'}, {max_uses: 3}]) {
      assert.equal(p.verifyEnvelope('invite', {...next, payload: {...next.payload, ...change}}, pubs[2]).ok, false);
    }
  }
  for (const bad of [{role: 'admin'}, {role: null}, ...[0, -1, 1.5, null, '2'].map(max_uses => ({max_uses}))]) {
    assert.throws(() => f.invite(bad));
  }
  for (const metadata of [{}, {role: 'lend', max_uses: 1}]) {
    assert.throws(() => f.invite({...metadata, expires_at: iso(f.now + 86401)}), e => e.code === 'invite_validity');
    assert.throws(() => f.invite({...metadata, expires_at: undefined}));
  }
});

test('new invite defaults stay one use and 24 hours; used copy names the signed owner', async t => {
  const c = await realCoordinator(t), links = await c.owner.createInviteLinks(c.circle.id, {ownerName: 'Ana'});
  const payload = p.decodeInviteLink(links.long).invite.payload;
  // Defaults are not signed, so an older Faravan (whose schema rejects unknown fields) can read this invite.
  assert.equal(Object.hasOwn(payload, 'role'), false); assert.equal(Object.hasOwn(payload, 'max_uses'), false);
  assert.equal(Date.parse(payload.expires_at) - Date.parse(payload.created_at), 86400000);
  const a = await c.device('one'), b = await c.device('two');
  const outcomes = await Promise.allSettled([a.joinCircle(links.long), b.joinCircle(links.long)]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  const error = outcomes.find(x => x.status === 'rejected').reason;
  assert.equal(error.code, 'enrollment_conflict'); // default invites keep the code older clients know
  assert.equal(error.message, 'This invitation was already used. Ask Ana for a new one.');
  const index = outcomes.findIndex(x => x.status === 'fulfilled'), winner = [a, b][index];
  const first = outcomes[index].value;
  c.restart();
  assert.equal((await winner.joinCircle(links.short)).enrollment.enrollment_id, first.enrollment.enrollment_id);
  assert.equal(first.joinInfo.role, 'lend');
});

test('multi-use invite persists consumption and owner approvals across restart', async t => {
  const c = await realCoordinator(t), links = await c.owner.createInviteLinks(c.circle.id, {role: 'both', max_uses: 2});
  const a = await c.device('a'), b = await c.device('b'), third = await c.device('third');
  const first = await a.joinCircle(links.short);
  assert.equal(first.joinInfo.role, 'both');
  assert.equal((await c.owner.approveEnrollments(c.circle.id)).approved.length, 1);
  c.restart();
  const second = await b.joinCircle(links.short);
  const owner = await c.device('owner');
  assert.equal((await owner.approveEnrollments(c.circle.id)).approved.length, 1);
  await assert.rejects(third.joinCircle(links.long), e => e.code === 'invite_used');
  const repeat = await owner.approveEnrollment(c.circle.id, second.enrollment.enrollment_id);
  assert.equal(repeat.alreadyApproved, true);
  await owner.removeMember(c.circle.id, b.keyId);
  await assert.rejects(owner.approveEnrollment(c.circle.id, second.enrollment.enrollment_id), e => e.code === 'not_found');
  await assert.rejects(third.joinCircle(links.long), e => e.code === 'invite_used');
});

test('legacy invite still joins as lend, stays one use and preserves its conflict code', async t => {
  const f = await goldenFixture(t), invite = f.invite();
  await f.post(invite);
  const link = p.encodeInviteLink(invite, Buffer.alloc(32, 4));
  const make = key => createClient({origin: f.origin, circle, deviceKey: keys[key], pinnedRootFingerprint: ids[2],
    rosterCache: {get: async () => null, set: async () => {}}, clock: () => f.now});
  await make(0).enroll(link);
  await assert.rejects(make(1).enroll(link), e => e.code === 'enrollment_conflict');
});

test('invalid lookup floods behind one peer cannot spend valid invite capacity', async t => {
  const f=await goldenFixture(t,{limits:{inviteLookupsPerSource:3,unauthenticatedFailures:3}}),pub=f.publication();
  assert.equal((await f.post(pub)).status,200);
  for(let i=0;i<35;i++) {
    const result=await f.get(i%2?'aaaaaaaaaa':'bad',{headers:{'X-Forwarded-For':'198.51.100.'+(i+1)}});
    assert.equal(result.status,i<3?404:429);
  }
  assert.equal((await f.get(pub.code,{headers:{'X-Forwarded-For':'203.0.113.2'}})).status,200);
 });

test('revoked short links use a specific 410 problem; an unrelated 403 is not called a revoke',async()=>{
  const link=p.encodeShortLink({coordinator:'https://circle.example',code:'abcdefghij',seed:randomBytes(32)});
  await assert.rejects(resolveJoinLink(link,{fetch:async()=>new Response(JSON.stringify({code:'enrollment_rejected'}),{status:410})}),error=>error.code==='enrollment_rejected');
  await assert.rejects(resolveJoinLink(link,{fetch:async()=>new Response(JSON.stringify({code:'enrollment_expired'}),{status:410})}),error=>error.code==='enrollment_expired');
  await assert.rejects(resolveJoinLink(link,{fetch:async()=>new Response('Forbidden',{status:403})}),error=>error.code==='network_error');
});
