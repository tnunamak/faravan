import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, cookieOf } from './helpers/phone-client.mjs';
import { openSessionStore } from '../lib/v1/browser-sessions.mjs';
import { createPairing, createPhoneAccess, lanAddresses, normalizeCode, phoneCard, phoneReach, MAX_CODE_FAILURES, PAIRING_TTL_MS, CONFIRM_WINDOW_MS } from '../lib/v1/phone-access.mjs';

let network = {eth0: [{address: '127.0.0.1', family: 'IPv4', internal: false}]};
const loopbackAsLan = () => network;

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'faravan-phone-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  return dir;
}

async function phoneFixture(t, {tls = false, cards = [], answer} = {}) {
  const dir = await scratch(t);
  let clock = 1_000_000;
  const now = () => clock;
  const sessions = await openSessionStore(join(dir, 'sessions.json'), {now});
  const answers = [];
  const access = createPhoneAccess({directory: dir, sessions, now, interfaces: loopbackAsLan, computerName: () => 'Studio Mac',
    inbox: async () => cards, answer: answer ?? (async (id, verb) => { answers.push([id, verb]); return {id, accepted: verb === 'accept'}; })});
  t.after(() => access.close());
  await access.start();
  let settings = {enabled: true, address: '127.0.0.1'};
  if (tls) {
    const key = join(dir, 'key.pem'), cert = join(dir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
      '-subj', '/CN=faravan.test', '-keyout', key, '-out', cert], {stdio: 'ignore'});
    settings = {...settings, certFile: cert, keyFile: key};
  }
  const status = await access.owner({method: 'POST', parts: ['settings'], input: settings, browserSession: true});
  return {dir, sessions, access, status, answers, advance: ms => { clock += ms; }, origin: () => access.origin};
}

async function pair(f, {label = 'Ana’s phone'} = {}) {
  const started = await f.access.owner({method: 'POST', parts: ['pairing']});
  const code = new URL(started.pairing.url).hash.slice(1);
  assert.match(started.pairing.qr.d, /^(M\d+ \d+h1v1h-1z)+$/, 'the QR of the pairing link comes as data');
  const claim = await call(f.origin(), '/phone/api/pair/claim', {method: 'POST', body: {code, label}});
  assert.equal(claim.status, 200, claim.text);
  const claimCookie = cookieOf(claim);
  const waiting = f.access.status().pairing;
  assert.deepEqual(waiting.phrase, claim.json.phrase, 'both screens show the same words');
  await f.access.owner({method: 'POST', parts: ['pairing', 'confirm'], input: {id: waiting.id, confirmed: true}, browserSession: true});
  const done = await call(f.origin(), '/phone/api/pair/status', {cookie: claimCookie});
  assert.equal(done.json.state, 'paired');
  return {cookie: cookieOf(done), claim};
}

test('a claimed phone label drops zero-width and bidi-override characters', () => {
  const p = createPairing({now: () => 0});
  const started = p.start();
  p.claim(started.code, {label: '\u202eenohP s\u2019miT\u202c\u200b\u2066x\u2069\ufeff', address: '10.23.1.9'});
  const label = p.view().phone.label;
  assert.ok(!/[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/.test(label), 'no invisible or reordering characters remain: ' + JSON.stringify(label));
  assert.equal(label, 'enohP s\u2019miTx');
});

test('a normal confirmed phone grant becomes durable on commit', async t => {
  const dir = await scratch(t), file = join(dir, 'sessions.json');
  const sessions = await openSessionStore(file, {limits: {phone: 1}});
  const pending = await sessions.create({kind: 'phone', label: 'Fixture phone', scopes: ['inbox:read'], pending: true});
  assert.equal(sessions.room('phone'), 0);
  assert.deepEqual(sessions.list('phone'), []);
  await sessions.commit(pending.id);
  assert.equal(sessions.verify(pending.secret, 'phone')?.id, pending.id);
  await sessions.close();
  const reopened = await openSessionStore(file);
  assert.deepEqual(reopened.list('phone').map(value => value.id), [pending.id]);
  await reopened.close();
});

test('a pairing code is single-use, short-lived and folds look-alike characters', async () => {
  let clock = 0; const p = createPairing({now: () => clock});
  const started = p.start();
  assert.match(started.code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  assert.equal(normalizeCode(' k7qm-3xpa '), 'K7QM3XPA');
  assert.equal(normalizeCode('oil'), '011');
  const claimed = p.claim(started.code.toLowerCase(), {label: 'Device', address: '10.23.1.9'});
  assert.equal(claimed.phrase.length, 3);
  assert.throws(() => p.claim(started.code, {label: 'Second phone'}), {code: 'pairing_not_open'}, 'a claimed code cannot be claimed again');
  const discard = () => assert.fail('successful or pre-confirmation collection must not discard');
  const create = async () => ({secret: 's'});
  assert.deepEqual(await p.collect(claimed.secret, create, discard), {state: 'waiting_for_computer'});
  assert.deepEqual(await p.collect('guess', create, discard), {state: 'unknown'});
  p.decide(started.id, true);
  await assert.rejects(p.collect(claimed.secret, async () => { throw Object.assign(new Error('x'), {code: 'too_many_phones'}); }, discard), {code: 'too_many_phones'});
  assert.equal((await p.collect(claimed.secret, create, discard)).state, 'confirmed', 'a refused session does not use up the pairing');
  assert.equal((await p.collect(claimed.secret, create, discard)).state, 'unknown', 'a confirmed pairing is collected exactly once');

  p.start(); clock += PAIRING_TTL_MS;
  assert.equal(p.view().state, 'expired');
  assert.throws(() => p.claim(p.view().code ?? 'X', {}), {code: 'pairing_not_open'});
});

test('a typed code claims the pairing in any case, with spaces, with or without a dash, or with an en or em dash', () => {
  const forms = code => [code.toLowerCase(), code.replace('-', ''), ` ${code.slice(0, 4)} ${code.slice(5)} `,
    code.replace('-', '–'), code.replace('-', '—'), `${code.slice(0, 4)} ${code.slice(5)}`];
  for (let i = 0; i < 6; i++) {
    const p = createPairing();
    const {code} = p.start();
    const typed = forms(code)[i];
    assert.equal(p.claim(typed, {label: 'Device'}).phrase.length, 3, JSON.stringify(typed));
  }
  assert.equal(normalizeCode('K7QM–3XPA'), 'K7QM3XPA');
  const p = createPairing();
  const {code} = p.start();
  assert.throws(() => p.claim(code.replace('-', '_'), {}), {code: 'wrong_code'}, 'an underscore is not a separator');
});

test('a pairing code is ASCII only: look-alike letters from other scripts are refused before upper-casing', () => {
  // Unicode upper-casing maps dotless ı to I (which folds to 1) and long s ſ to S, so they must be refused first.
  assert.equal(normalizeCode('K7QM3XPı'), '');
  assert.equal(normalizeCode('K7QM3XPſ'), '');
  assert.equal(normalizeCode('K7QMſXPA'), '');
  const p = createPairing();
  const {code} = p.start();
  assert.throws(() => p.claim(code.slice(0, 7) + 'ı', {}), {code: 'wrong_code'});
  assert.throws(() => p.claim(code.slice(0, 7) + 'ſ', {}), {code: 'wrong_code'});
  // Every separator form already accepted still works, including a non-breaking space.
  for (const typed of [' k7qm 3xpa ', 'k7qm 3xpa', 'K7QM–3XPA', 'K7QM—3XPA', 'k7qm-3xpa'])
    assert.equal(normalizeCode(typed), 'K7QM3XPA', JSON.stringify(typed));
});

test('five wrong codes end the pairing; a late confirmation is not collected', async () => {
  let clock = 0; const p = createPairing({now: () => clock});
  const {code} = p.start();
  for (let i = 1; i < MAX_CODE_FAILURES; i++) assert.throws(() => p.claim('AAAA-AAAA', {}), {code: 'wrong_code'});
  assert.throws(() => p.claim('AAAA-AAAA', {}), {code: 'too_many_tries'});
  assert.throws(() => p.claim(code, {}), {code: 'pairing_not_open'}, 'the right code no longer works after the limit');

  const second = p.start();
  const claimed = p.claim(second.code, {});
  clock += CONFIRM_WINDOW_MS;
  assert.throws(() => p.decide(second.id, true), {code: 'pairing_not_open'}, 'nobody confirmed in time');
  assert.equal((await p.collect(claimed.secret, async () => ({}), () => assert.fail('unconfirmed pairing made a session'))).state, 'expired');
});

test('reach wording never claims more than the setup gives', () => {
  assert.equal(phoneReach({enabled: false}).state, 'off');
  const http = phoneReach({enabled: true, listening: true, https: false, address: '10.23.1.20', kind: 'lan'});
  assert.equal(http.headline, 'Paired devices can see requests, not answer them');
  assert.ok(http.facts.some(f => f.includes('same network') && f.includes('awake')));
  assert.ok(http.facts.some(f => /cannot install it as an app or get notifications/.test(f)));
  const https = phoneReach({enabled: true, listening: true, https: true, address: '10.23.1.20', kind: 'lan'});
  assert.ok(https.facts.some(f => /No notifications yet/.test(f)));
  assert.ok(https.facts.some(f => /do not continue past that warning/.test(f)));
  assert.match(phoneReach({enabled: true, listening: true, https: true, kind: 'tailnet'}).facts[0], /tailnet/);
  // A full-app phone can do more than answer requests; the copy says what each pairing choice gives and when it works.
  const served = phoneReach({enabled: true, listening: true, https: true, kind: 'tailnet', full: true, tailscaleHttps: true});
  assert.equal(served.headline, 'Paired devices can use Faravan on this computer');
  assert.ok(served.facts[0].includes('Faravan is running'));
  assert.ok(served.facts.some(f => /requests only, or the whole Faravan app/.test(f)));
  assert.ok(served.facts.some(f => /Tailscale address/.test(f)) && !served.facts.some(f => /your certificate/.test(f)));
  const tailnetHttp = phoneReach({enabled: true, listening: true, https: false, kind: 'tailnet', full: true});
  assert.equal(tailnetHttp.headline, 'Paired devices can use Faravan on this computer');
  assert.ok(tailnetHttp.facts.some(f => /requests only \(it can see them, not answer them\)/.test(f)));
  assert.ok(!tailnetHttp.facts.some(f => /anyone on this network could read/.test(f)), 'Tailscale encrypts the link');
  // Requests-only over a Tailscale address: the encryption fact is true, so the plain-HTTP warning must not appear.
  const tailnetRequests = phoneReach({enabled: true, listening: true, https: false, kind: 'tailnet'});
  assert.equal(tailnetRequests.headline, 'Paired devices can see requests, not answer them');
  assert.ok(tailnetRequests.facts.includes('Tailscale encrypts this connection. Answering requests still needs HTTPS.'));
  assert.ok(!tailnetRequests.facts.some(f => /plain HTTP|anyone on this network/.test(f)), 'no plain-HTTP warning over Tailscale');
  // Requests-only over a LAN address: the plain-HTTP warning stays, and the Tailscale sentence does not.
  assert.ok(http.facts.includes('This uses plain HTTP, so anyone on this network could read what the device sees. That is why a device paired this way can look but not answer.'));
  assert.ok(!http.facts.some(f => /Tailscale encrypts/.test(f)));
  assert.deepEqual(lanAddresses({lo: [{address: '127.0.0.1', family: 'IPv4', internal: true}],
    wlan0: [{address: '10.23.1.20', family: 'IPv4', internal: false}], ts: [{address: '100.101.1.2', family: 'IPv4', internal: false}],
    v6: [{address: 'fe80::1', family: 'IPv6', internal: false}], ll: [{address: '169.254.3.3', family: 'IPv4', internal: false}]}).map(a => a.kind),
  ['lan', 'tailnet'], 'link-local and IPv6 are left out');
  assert.deepEqual(lanAddresses({eth0: [{address: '203.0.113.7', family: 'IPv4', internal: false}]}), [], 'a public address is never offered');
});

test('a device card carries the prompt only over an encrypted connection', () => {
  const card = {id: 'c1', localName: 'Ana', harness: 'claude', runtimeSeconds: 600, network: {mode: 'none'}, prompt: 'Fix the login bug', expiresAt: 5000};
  assert.equal(phoneCard(card, {https: true}).prompt, 'Fix the login bug');
  const plain = phoneCard(card, {https: false});
  assert.equal(plain.prompt, undefined);
  assert.equal(plain.promptHidden, true);
  assert.equal(plain.requester, 'Ana');
});

test('pairing over HTTP: code, matching words, confirmation here, then a read-only phone', async t => {
  const card = {id: 'r1', localName: 'Ana', harness: 'claude', runtimeSeconds: 900, network: {mode: 'none'}, prompt: 'secret plan', expiresAt: 2_000_000, job: {}, label: 'x'};
  const f = await phoneFixture(t, {cards: [card]});
  assert.equal(f.status.reach.state, 'http');
  assert.match(f.origin(), /^http:\/\/127\.0\.0\.1:\d+$/);
  const {cookie, claim} = await pair(f);
  assert.deepEqual(claim.json.scopes, ['inbox:read']);
  assert.match(claim.headers['set-cookie'][0], /HttpOnly; SameSite=Strict$/);

  const inbox = await call(f.origin(), '/phone/api/inbox', {cookie});
  assert.equal(inbox.status, 200);
  assert.equal(inbox.json.computer, 'Studio Mac');
  assert.equal(inbox.json.canAnswer, false);
  assert.equal(inbox.json.needs[0].requester, 'Ana');
  assert.equal(inbox.text.includes('secret plan'), false, 'no prompt text over plain HTTP');

  const answer = await call(f.origin(), '/phone/api/requests/r1/accept', {method: 'POST', body: {}, cookie});
  assert.equal(answer.status, 403);
  assert.deepEqual(f.answers, [], 'a read-only phone never reaches the answer seam');

  assert.equal(f.access.status().phones.length, 1);
  assert.equal(f.access.status().phones[0].label, 'Ana’s phone');
  await f.access.owner({method: 'POST', parts: ['phones', f.access.status().phones[0].id, 'revoke']});
  assert.equal((await call(f.origin(), '/phone/api/inbox', {cookie})).status, 401, 'revoking ends access at once');
});

test('confirmation needs the browser on this computer, not just the session token', async t => {
  const f = await phoneFixture(t);
  const started = await f.access.owner({method: 'POST', parts: ['pairing']});
  const code = new URL(started.pairing.url).hash.slice(1);
  await call(f.origin(), '/phone/api/pair/claim', {method: 'POST', body: {code, label: 'x'}});
  await assert.rejects(f.access.owner({method: 'POST', parts: ['pairing', 'confirm'], input: {id: started.pairing.id, confirmed: true}}),
    {code: 'confirm_on_this_computer', status: 403});
  assert.equal(f.access.status().pairing.state, 'claimed');
});

test('a rejected pairing never yields a session', async t => {
  const f = await phoneFixture(t);
  const started = await f.access.owner({method: 'POST', parts: ['pairing']});
  const claim = await call(f.origin(), '/phone/api/pair/claim', {method: 'POST', body: {code: new URL(started.pairing.url).hash.slice(1)}});
  await f.access.owner({method: 'POST', parts: ['pairing', 'confirm'], input: {id: started.pairing.id, confirmed: false}, browserSession: true});
  const status = await call(f.origin(), '/phone/api/pair/status', {cookie: cookieOf(claim)});
  assert.equal(status.json.state, 'rejected');
  assert.equal(status.headers['set-cookie'], undefined);
  assert.equal(f.access.status().phones.length, 0);
});

test('the device listener refuses other host names, foreign origins, origin-less posts and local sessions', async t => {
  const f = await phoneFixture(t);
  const port = new URL(f.origin()).port;
  assert.equal((await call(f.origin(), '/', {host: 'evil.example:' + port})).status, 403, 'DNS rebinding');
  const started = await f.access.owner({method: 'POST', parts: ['pairing']});
  const code = new URL(started.pairing.url).hash.slice(1);
  assert.equal((await call(f.origin(), '/phone/api/pair/claim', {method: 'POST', body: {code}, originHeader: 'https://evil.example'})).status, 403);
  assert.equal((await call(f.origin(), '/phone/api/pair/claim', {method: 'POST', body: {code}, originHeader: null})).status, 403);
  const local = await f.sessions.create({kind: 'local', label: 'Browser'});
  const name = 'faravan_phone_' + f.sessions.instance;
  assert.equal((await call(f.origin(), '/phone/api/inbox', {cookie: name + '=' + local.secret})).status, 401, 'a local session is not a device session');
  const page = await call(f.origin(), '/pair');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/);
  assert.match(page.text, /<html/);
  assert.equal((await call(f.origin(), '/api/status')).status, 404, 'the local app API is not served to phones');
  assert.equal((await call(f.origin(), '/app.mjs')).status, 404, 'nor the local app itself');
});

test('over HTTPS a paired phone sees the prompt and can answer; the cookie is Secure', async t => {
  const card = {id: 'r2', localName: 'Ben', harness: 'codex', runtimeSeconds: 300, network: {mode: 'none'}, prompt: 'Add tests', expiresAt: 2_000_000};
  const f = await phoneFixture(t, {tls: true, cards: [card]});
  assert.equal(f.status.reach.state, 'https', JSON.stringify(f.status.reach));
  assert.match(f.origin(), /^https:/);
  const {cookie, claim} = await pair(f);
  assert.deepEqual(claim.json.scopes, ['inbox:read', 'requests:answer']);
  assert.match(claim.headers['set-cookie'][0], /; Secure$/);
  const inbox = await call(f.origin(), '/phone/api/inbox', {cookie});
  assert.equal(inbox.json.canAnswer, true);
  assert.equal(inbox.json.needs[0].prompt, 'Add tests');
  const answered = await call(f.origin(), '/phone/api/requests/r2/decline', {method: 'POST', body: {}, cookie});
  assert.equal(answered.status, 200, answered.text);
  assert.deepEqual(f.answers, [['r2', 'skip']]);
});

test('history: answered on the device, on the computer, or expired', async t => {
  const f = await phoneFixture(t, {tls: true, answer: async (id, verb) => { f.access.observe({id, state: verb === 'accept' ? 'accepted' : 'skipped'}); return {id}; }});
  const card = id => ({id, job: {}, label: 'This job needs your review', localName: 'Ana', harness: 'claude', prompt: 'p'});
  f.access.observe(card('a')); f.access.observe(card('b')); f.access.observe(card('c')); f.access.observe(card('own'));
  const {cookie} = await pair(f, {label: 'Pixel'});
  await call(f.origin(), '/phone/api/requests/a/accept', {method: 'POST', body: {}, cookie});
  f.access.observe({id: 'b', state: 'skipped'});
  f.access.observe({id: 'c', state: 'expired'});
  f.access.observe({id: 'own', state: 'accepted', auto: 'own job'});
  const inbox = (await call(f.origin(), '/phone/api/inbox', {cookie})).json;
  assert.deepEqual(inbox.answered.map(i => [i.id, i.state, i.by]), [['b', 'declined', 'this computer'], ['a', 'accepted', 'Pixel']]);
  assert.deepEqual(inbox.expired.map(i => i.id), ['c']);
});

test('phone settings persist, and turning access off closes the listener', async t => {
  const f = await phoneFixture(t);
  const saved = JSON.parse(await readFile(join(f.dir, 'phone.json'), 'utf8'));
  assert.equal(saved.enabled, true);
  const origin = f.origin();
  const off = await f.access.owner({method: 'POST', parts: ['settings'], input: {enabled: false}});
  assert.equal(off.reach.state, 'off');
  assert.equal(off.origin, null);
  await assert.rejects(call(origin, '/'), /ECONNREFUSED/);
  await assert.rejects(f.access.owner({method: 'POST', parts: ['pairing']}), {code: 'phone_access_off'});
  await assert.rejects(f.access.owner({method: 'POST', parts: ['settings'], input: {enabled: true, certFile: '/x'}, browserSession: true}), {code: 'invalid_request'});
  await assert.rejects(f.access.owner({method: 'POST', parts: ['settings'], input: {enabled: true}}), {code: 'local_session_required', status: 403},
    'the session token alone cannot open this computer to the network');
  const back = await f.access.owner({method: 'POST', parts: ['settings'], input: {enabled: true}, browserSession: true});
  assert.equal(back.origin, origin, 'the device address stays the same, so an installed phone app keeps working');
});

test('an address that left this computer is reported, not silently swapped; a public or unknown one is refused', async t => {
  const f = await phoneFixture(t);
  await assert.rejects(f.access.owner({method: 'POST', parts: ['settings'], input: {enabled: true, address: '203.0.113.7'}, browserSession: true}),
    {code: 'address_not_available'});
  const saved = network;
  network = {wlan0: [{address: '10.23.77.77', family: 'IPv4', internal: false}]};
  t.after(() => { network = saved; });
  const status = await f.access.owner({method: 'POST', parts: ['settings'], input: {enabled: true}, browserSession: true});
  assert.equal(status.reach.state, 'problem');
  assert.match(status.reach.facts[0], /127\.0\.0\.1 is not on this computer/);
});

test('a computer with all its phones paired says so before a code is shown, and a confirmed phone can finish after one is removed', async t => {
  const dir = await scratch(t);
  const sessions = await openSessionStore(join(dir, 'sessions.json'), {limits: {phone: 1}});
  const access = createPhoneAccess({directory: dir, sessions, interfaces: loopbackAsLan, inbox: async () => [], answer: async () => ({})});
  t.after(() => access.close());
  await access.start();
  await access.owner({method: 'POST', parts: ['settings'], input: {enabled: true, address: '127.0.0.1'}, browserSession: true});
  const f = {access, origin: () => access.origin};
  await pair(f, {label: 'First'});
  await assert.rejects(access.owner({method: 'POST', parts: ['pairing']}), {code: 'too_many_phones', status: 409});

  // The race the up-front check cannot close: room when confirmed, none when the device collects.
  const first = access.status().phones[0];
  await access.owner({method: 'POST', parts: ['phones', first.id, 'revoke']});
  const started = await access.owner({method: 'POST', parts: ['pairing']});
  const claim = await call(access.origin, '/phone/api/pair/claim', {method: 'POST', body: {code: new URL(started.pairing.url).hash.slice(1), label: 'Second'}});
  await access.owner({method: 'POST', parts: ['pairing', 'confirm'], input: {id: started.pairing.id, confirmed: true}, browserSession: true});
  const squatter = await sessions.create({kind: 'phone', label: 'Raced', scopes: ['inbox:read']});
  const blocked = await call(access.origin, '/phone/api/pair/status', {cookie: cookieOf(claim)});
  assert.equal(blocked.json.state, 'too_many_phones');
  assert.equal(blocked.headers['set-cookie'], undefined);
  await sessions.revoke(squatter.id);
  const done = await call(access.origin, '/phone/api/pair/status', {cookie: cookieOf(claim)});
  assert.equal(done.json.state, 'paired', 'the same pairing finishes once there is room');
});

test('offer history waits for a successful claim event and keeps phone attribution', async t => {
  const digest='sha256:'+'a'.repeat(64);
  const f=await phoneFixture(t,{tls:true,answer:async(id,verb)=>{
    f.access.observe({id,state:verb==='accept'?'accepting':'skipped',offer:true});
    if(verb==='accept')f.access.observe({state:'accepted',jobDigest:digest,offer:true});
    return {id};
  }});
  const card={id:'offer',jobDigest:digest,offer:true,job:{},label:'A job is available to run',localName:'Ana',harness:'claude'};
  f.access.observe(card);
  const {cookie}=await pair(f,{label:'Pixel'});
  await call(f.origin(),'/phone/api/requests/offer/accept',{method:'POST',body:{},cookie});
  const inbox=(await call(f.origin(),'/phone/api/inbox',{cookie})).json;
  assert.deepEqual(inbox.answered.map(i=>[i.id,i.state,i.by,i.offer]),[['offer','accepted','Pixel',true]]);
  f.access.observe({...card,id:'dismiss'});
  await call(f.origin(),'/phone/api/requests/dismiss/decline',{method:'POST',body:{},cookie});
  const after=(await call(f.origin(),'/phone/api/inbox',{cookie})).json;
  assert.equal(after.answered[0].state,'dismissed');
});

test('a long valid host name keeps manual pairing usable when the QR link does not fit', async t => {
  const f=await phoneFixture(t);
  const hostname=[63,63,63,55].map(n=>'a'.repeat(n)).join('.');
  await f.access.owner({method:'POST',parts:['settings'],input:{enabled:true,address:'127.0.0.1',hostname},browserSession:true});
  const view=await f.access.owner({method:'POST',parts:['pairing']});
  assert.match(view.pairing.code,/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(view.pairing.qr,null);
  assert.ok(view.pairing.url.includes(hostname));
});

test('an HTTP claim keeps its confirmed metadata-only grant when HTTPS is enabled before collection', async t => {
  const f=await phoneFixture(t,{cards:[{id:'request',prompt:'Private task',localName:'Ana'}]});
  const started=await f.access.owner({method:'POST',parts:['pairing']});
  const claim=await call(f.origin(),'/phone/api/pair/claim',{method:'POST',body:{code:started.pairing.code}});
  assert.deepEqual(claim.json.scopes,['inbox:read']);
  await f.access.owner({method:'POST',parts:['pairing','confirm'],input:{id:started.pairing.id,confirmed:true},browserSession:true});
  const key=join(f.dir,'upgrade-key.pem'),cert=join(f.dir,'upgrade-cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=faravan.test','-keyout',key,'-out',cert],{stdio:'ignore'});
  await f.access.owner({method:'POST',parts:['settings'],input:{enabled:true,address:'127.0.0.1',certFile:cert,keyFile:key},browserSession:true});
  assert.deepEqual(f.access.status().pairing.scopes,['inbox:read']);
  const collected=await call(f.origin(),'/phone/api/pair/status',{cookie:cookieOf(claim)});
  assert.equal(collected.json.state,'paired');
  const inbox=await call(f.origin(),'/phone/api/inbox',{cookie:cookieOf(collected)});
  assert.deepEqual(inbox.json.phone.scopes,['inbox:read']);
  assert.equal(inbox.json.canAnswer,false);
  assert.equal(inbox.json.needs[0].prompt,undefined,'a grant made over HTTP cannot gain task text either');
  assert.equal((await call(f.origin(),'/phone/api/requests/request/accept',{method:'POST',body:{},cookie:cookieOf(collected)})).status,403);
});

test('a confirmed phone finishes without disturbing another pairing', async () => {
  const p=createPairing(),first=p.start();
  const claim=p.claim(first.code,{label:'First'});p.decide(first.id,true);
  let finish;
  const collected=p.collect(claim.secret,()=>new Promise(resolve=>{finish=resolve;}),()=>assert.fail('another pairing is not cancellation'));
  const next=p.start();finish({id:'first-session',secret:'first-secret'});
  assert.deepEqual(await collected,{state:'confirmed',created:{id:'first-session',secret:'first-secret'}});
  assert.equal(p.view().id,next.id);
  assert.equal(p.view().state,'waiting');
});

test('a confirmed HTTPS claim cannot issue a privileged cookie after switching to HTTP', async t => {
  const f=await phoneFixture(t,{tls:true});
  const started=await f.access.owner({method:'POST',parts:['pairing']});
  const claim=await call(f.origin(),'/phone/api/pair/claim',{method:'POST',body:{code:started.pairing.code}});
  await f.access.owner({method:'POST',parts:['pairing','confirm'],input:{id:started.pairing.id,confirmed:true},browserSession:true});
  await f.access.owner({method:'POST',parts:['settings'],input:{enabled:true,address:'127.0.0.1'},browserSession:true});
  const result=await call(f.origin(),'/phone/api/pair/status',{cookie:cookieOf(claim)});
  assert.equal(result.json.state,'cancelled');
  assert.equal(result.headers['set-cookie'],undefined);
  assert.equal(f.sessions.list('phone').length,0);
});
