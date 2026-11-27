import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { appFixture, api, boundedFetch, waitFor } from './helpers/v1-app-fixture.mjs';
import { call, cookieOf } from './helpers/phone-client.mjs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startProviderGenerationAuth } from '../lib/provider-generation-auth.mjs';
import { CODEX_HARNESS } from '../lib/harnesses.mjs';
import { freePort, fakeCodex, STATE, CODE } from './helpers/fake-codex-redirect.mjs';

import { createPairing, CONFIRM_WINDOW_MS } from '../lib/v1/phone-access.mjs';

for (const action of ['cancel', 'replace', 'expire']) {
  test('late persisted phone session is revoked after ' + action, {timeout: 5000}, async () => {
    let time = 1000;
    const pairing = createPairing({now: () => time});
    const first = pairing.start();
    const claim = pairing.claim(first.rawCode, {label: 'Synthetic phone'});
    pairing.decide(first.id, true);
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    const stored = new Map([['unrelated-session', {label: 'Synthetic unrelated phone'}]]);
    const revoked = [];
    let creates = 0;
    const pending = pairing.collect(claim.secret, async () => {
      creates++;
      stored.set('late-session', {label: 'Synthetic phone'});
      entered();
      await held;
      return {id: 'late-session'};
    }, async id => {
      revoked.push(id);
      stored.delete(id);
    });
    await started;
    assert.deepEqual(await pairing.collect(claim.secret, () => {
      throw new Error('concurrent collection must not create twice');
    }), {state: 'waiting_for_computer'});
    if (action === 'cancel') pairing.cancel(first.id);
    else if (action === 'replace') pairing.start();
    else time += CONFIRM_WINDOW_MS;
    const successor = pairing.view();
    release();
    const result = await pending;
    assert.deepEqual(result, {state: action === 'cancel' ? 'cancelled' : action === 'expire' ? 'expired' : 'unknown'});
    assert.equal(Object.hasOwn(result, 'created'), false, 'retired session cannot enter the route cookie branch');
    assert.deepEqual(revoked, ['late-session']);
    assert.deepEqual([...stored.keys()], ['unrelated-session'], 'exact cleanup leaves other sessions alone');
    assert.equal(creates, 1);
    if (action === 'expire') assert.equal(pairing.view().state, 'expired');
    else assert.deepEqual(pairing.view(), successor, 'late completion preserves the current pairing');
    if (action === 'replace') {
      pairing.cancel(first.id);
      assert.deepEqual(pairing.view(), successor, 'exact old cancel leaves successor alone');
      const next = pairing.claim(successor.rawCode, {label: 'Synthetic successor'});
      pairing.decide(successor.id, true);
      assert.deepEqual(await pairing.collect(next.secret, async () => ({id: 'successor-session'})),
        {state: 'confirmed', created: {id: 'successor-session'}});
    }
  });
}

test('confirmed phone pairing retries room refusal and is collected only once', async () => {
  const pairing = createPairing();
  const first = pairing.start();
  const claim = pairing.claim(first.rawCode, {label: 'Synthetic ordinary phone'});
  pairing.decide(first.id, true);
  const before = pairing.view();
  pairing.cancel('not-the-current-id');
  assert.deepEqual(pairing.view(), before);
  await assert.rejects(pairing.collect(claim.secret, async () => {
    throw Object.assign(new Error('too_many_phones'), {code: 'too_many_phones'});
  }), {code: 'too_many_phones'});
  assert.equal(pairing.view().state, 'confirmed');
  const revoked = [];
  assert.deepEqual(await pairing.collect(claim.secret, async () => ({id: 'ordinary-session'}), async id => { revoked.push(id); }),
    {state: 'confirmed', created: {id: 'ordinary-session'}});
  assert.deepEqual(revoked, []);
  assert.equal(pairing.view().state, 'collected');
  assert.deepEqual(await pairing.collect(claim.secret, () => { throw new Error('must not collect twice'); }),
    {state: 'unknown'});
});

const testOptions = {timeout: 120000};
const networkInterfaces = () => ({eth0: [{address: '127.0.0.1', family: 'IPv4', internal: false}]});

async function browserCookie(app) {
  const response = await boundedFetch(app.handoffUrl(), {redirect: 'manual'});
  await response.text();
  return response.headers.get('set-cookie').split(';')[0];
}

async function pairPhone(app, phoneOrigin, {access} = {}) {
  const started = await api(app, '/api/phone/pairing', {method: 'POST', body: access ? {access} : {}});
  assert.equal(started.pairing.state, 'waiting');
  assert.match(started.pairing.code, /^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  assert.equal(started.pairing.url, phoneOrigin + '/pair#' + started.pairing.code.replace('-', ''));
  assert.ok(started.pairing.qr.d.length > 100 && started.pairing.qr.size >= 29, 'the computer can draw the QR');
  const claim = await call(phoneOrigin, '/phone/api/pair/claim', {method: 'POST', body: {code: started.pairing.code, label: 'Test phone'}});
  assert.equal(claim.status, 200, claim.text);
  const waiting = await api(app, '/api/phone');
  assert.deepEqual(waiting.pairing.phrase, claim.json.phrase);
  assert.equal(waiting.pairing.phone.label, 'Test phone');
  // The session token alone (a script, an agent, the CLI) cannot hand a phone access.
  const refused = await api(app, '/api/phone/pairing/confirm', {method: 'POST', body: {id: waiting.pairing.id, confirmed: true}, status: 403});
  assert.equal(refused.code, 'confirm_on_this_computer');
  const cookie = await browserCookie(app), origin = new URL(app.origin).origin;
  await api(app, '/api/phone/pairing/confirm', {method: 'POST', token: null, headers: {cookie, origin},
    body: {id: waiting.pairing.id, confirmed: true}});
  const done = await call(phoneOrigin, '/phone/api/pair/status', {cookie: cookieOf(claim)});
  assert.equal(done.json.state, 'paired', done.text);
  return cookieOf(done);
}

test('local browser device lookup is authenticated and reports no phone session', testOptions, async t => {
  const f = await appFixture(t), {app} = await f.start('local');
  const unauthorized = await boundedFetch(new URL('/phone/api/inbox',app.origin));
  assert.equal(unauthorized.status,401);
  const response = await boundedFetch(new URL('/phone/api/inbox',app.origin), {headers:{cookie:await browserCookie(app)}});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{phone:null});
});

test('a phone pairs through the app, stays paired across a restart, and never reaches the local app', testOptions, async t => {
  const f = await appFixture(t);
  let {app} = await f.start('phone', {networkInterfaces});
  assert.equal((await api(app, '/api/phone')).reach.state, 'off');
  assert.equal((await api(app, '/api/phone/settings', {method: 'POST', body: {enabled: true, address: '127.0.0.1'}, status: 403})).code, 'local_session_required');
  const here = {cookie: await browserCookie(app), origin: new URL(app.origin).origin};
  const on = await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here, body: {enabled: true, address: '127.0.0.1'}});
  assert.equal(on.reach.state, 'http');
  const phoneOrigin = on.origin;
  assert.notEqual(new URL(phoneOrigin).port, new URL(app.origin).port, 'the phone has its own listener');
  const phone = await pairPhone(app, phoneOrigin);

  const inbox = await call(phoneOrigin, '/phone/api/inbox', {cookie: phone});
  assert.equal(inbox.status, 200, inbox.text);
  assert.deepEqual(inbox.json.needs, []);
  assert.equal(inbox.json.canAnswer, false);
  assert.equal((await api(app, '/api/phone')).phones[0].label, 'Test phone');

  // A phone cookie is not a local session, on either name.
  const value = phone.split('=')[1];
  const instance = phone.split('=')[0].replace('faravan_phone_', '');
  for (const cookie of [phone, 'faravan_local_session_' + instance + '=' + value])
    await api(app, '/api/status', {token: null, headers: {cookie}, status: 401});

  await app.close();
  ({app} = await f.start('phone', {networkInterfaces}));
  const after = await api(app, '/api/phone');
  assert.equal(after.origin, phoneOrigin, 'the phone address survives a restart, so an installed phone app keeps working');
  assert.equal((await call(phoneOrigin, '/phone/api/inbox', {cookie: phone})).status, 200, 'and the phone stays paired');

  await api(app, '/api/phone/phones/' + after.phones[0].id + '/revoke', {method: 'POST', body: {}}); // the token is enough to remove
  assert.equal((await call(phoneOrigin, '/phone/api/inbox', {cookie: phone})).status, 401);
  assert.equal((await api(app, '/api/phone')).phones.length, 0);
  assert.equal((await api(app, '/api/phone/settings', {method: 'POST', body: {enabled: false}})).reach.state, 'off', 'the token is enough to turn off');
});

test('over HTTPS a paired phone sees a real review card and declines it for this computer', testOptions, async t => {
  const f = await appFixture(t);
  const {owner, lender, circle} = await f.connect({networkInterfaces});
  const app = lender.app;
  const dir = await f.home('lender');
  const key = join(dir, 'phone-key.pem'), cert = join(dir, 'phone-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=faravan.test', '-keyout', key, '-out', cert], {stdio: 'ignore'});
  const here = {cookie: await browserCookie(app), origin: new URL(app.origin).origin};
  const on = await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here, body: {enabled: true, address: '127.0.0.1', certFile: cert, keyFile: key}});
  assert.equal(on.reach.state, 'https', JSON.stringify(on.reach));
  const phone = await pairPhone(app, on.origin);

  await api(app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'ask'}});
  await api(app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id, git: 'https://github.com/example/synthetic.git',
    commit: '1'.repeat(40), prompt: 'Synthetic task: write a greeting.', harness: 'codex'}});
  const card = await waitFor(async () => (await api(app, '/api/approvals'))[0], 'review card');

  assert.equal(card.offer, true, 'modern peers use offers before a claim');
  const inbox = await call(on.origin, '/phone/api/inbox', {cookie: phone});
  assert.equal(inbox.json.canAnswer, true);
  assert.equal(inbox.json.needs[0].id, card.id);
  assert.equal(inbox.json.needs[0].prompt, 'Synthetic task: write a greeting.');
  assert.equal(inbox.json.needs[0].network, card.network, 'the phone says what network the job gets');
  assert.equal(typeof inbox.json.needs[0].network, 'string');
  const declined = await call(on.origin, '/phone/api/requests/' + card.id + '/decline', {method: 'POST', body: {}, cookie: phone});
  assert.equal(declined.status, 200, declined.text);
  assert.deepEqual(await api(app, '/api/approvals'), []);
  const receipt=(await api(app,'/api/decisions')).events.find(row=>row.id===card.id);
  const paired=(await api(app,'/api/phone')).phones[0];
  assert.equal(receipt.surface,'phone');
  assert.deepEqual(receipt.decider,{sessionId:paired.id,label:'Test phone'});
  assert.equal(receipt.owner.deviceKey,app.device.keyId);
  const later = await call(on.origin, '/phone/api/inbox', {cookie: phone});
  assert.deepEqual(later.json.answered.map(item => [item.id, item.state, item.by]), [[card.id, 'dismissed', 'Test phone']]);
});

test('a phone paired for the full app uses the local app through its own listener, never as the person at this computer', testOptions, async t => {
  const f = await appFixture(t);
  const {app} = await f.start('phone-full', {networkInterfaces});
  const dir = await f.home('phone-full');
  const here = {cookie: await browserCookie(app), origin: new URL(app.origin).origin};

  // Plain HTTP on a home network: the full app is not offered and cannot be asked for.
  const http = await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here, body: {enabled: true, address: '127.0.0.1'}});
  assert.equal(http.reach.state, 'http');
  assert.equal(http.fullAvailable, false);
  assert.equal((await api(app, '/api/phone/pairing', {method: 'POST', body: {access: 'full'}, status: 409})).code, 'full_access_needs_encryption');
  assert.equal((await api(app, '/api/phone/pairing', {method: 'POST', body: {access: 'everything'}, status: 400})).code, 'invalid_request');

  const key = join(dir, 'phone-key.pem'), cert = join(dir, 'phone-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=faravan.test', '-keyout', key, '-out', cert], {stdio: 'ignore'});
  const on = await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here, body: {enabled: true, address: '127.0.0.1', certFile: cert, keyFile: key}});
  assert.equal(on.reach.state, 'https');
  assert.equal(on.fullAvailable, true);
  const phoneOrigin = on.origin;

  const narrow = await pairPhone(app, phoneOrigin);
  assert.equal((await call(phoneOrigin, '/api/status', {cookie: narrow})).status, 404, 'a requests-only phone never reaches the app');

  const started = await api(app, '/api/phone/pairing', {method: 'POST', body: {access: 'full'}});
  assert.equal(started.pairing.full, true);
  assert.ok(started.pairing.scopes.includes('app:full'), 'the computer shows the grant before anyone confirms');
  await api(app, '/api/phone/pairing/cancel', {method: 'POST', body: {id: started.pairing.id}});
  const full = await pairPhone(app, phoneOrigin, {access: 'full'});
  const paired = (await api(app, '/api/phone')).phones.find(phone => phone.scopes?.includes('app:full'));
  assert.ok(paired, 'the full phone is listed with its scope');

  const shell = await call(phoneOrigin, '/', {cookie: full});
  assert.equal(shell.status, 200);
  const phonePage = await call(phoneOrigin, '/', {cookie: narrow});
  assert.notEqual(shell.text, phonePage.text, 'a full phone gets the app shell at /, not the phone page');
  assert.equal((await call(phoneOrigin, '/pair')).status, 200, 'the pairing page stays on the phone listener');

  const status = await call(phoneOrigin, '/api/status', {cookie: full});
  assert.equal(status.status, 200, status.text);
  assert.deepEqual(Object.keys(status.json).sort(), Object.keys(await api(app, '/api/status')).sort());
  await f.provisionFromHome('phone-full');
  const circle=await api(app,'/api/circles',{method:'POST',body:{origin:f.origin,name:'Agent permissions'}});
  await api(app,'/api/circles/'+circle.id+'/agent-borrowing',{method:'POST',token:null,headers:here,body:{enabled:true}});
  const phoneSend=await call(phoneOrigin,'/api/ops/jobs.submit',{method:'POST',cookie:full,
    body:{circle:circle.id,prompt:'Say hello',noSource:true,result:{kind:'message'}}});
  assert.equal(phoneSend.status,428,phoneSend.text);
  assert.equal(phoneSend.json.code,'confirmation_required');
  const phoneEnable=await call(phoneOrigin,'/api/circles/'+circle.id+'/agent-borrowing',{method:'POST',cookie:full,
    body:{enabled:true}});
  assert.equal(phoneEnable.status,403,phoneEnable.text);
  assert.match(phoneEnable.json.message,/Circles/);
  const directSend=await call(phoneOrigin,'/api/jobs',{method:'POST',cookie:full,body:{circle:circle.id,prompt:'Say hello',noSource:true,result:{kind:'message'}}});
  assert.equal(directSend.status,428,directSend.text);
  const opEnable=await call(phoneOrigin,'/api/ops/circles.set_agent_borrowing',{method:'POST',cookie:full,body:{circle:circle.id,enabled:true}});
  assert.equal(opEnable.status,400,opEnable.text);
  const limits = await call(phoneOrigin, '/api/lending/limits', {method: 'POST', cookie: full, body: {dailyJobs: 2, dailyMinutes: 30, maxWallSeconds: 900, idleOnly: false}});
  assert.equal(limits.status, 200, limits.text);
  assert.equal(limits.headers['content-type'].split(';')[0], 'application/json');

  // Setup routes currently use full-app authorization, including full phones.
  // Keep this gap visible until their local-only policy is changed together.
  for(const route of ['restart-sandbox','repair-policy']) {
    const result=await call(phoneOrigin,'/api/setup/'+route,{method:'POST',cookie:full,body:{}});
    assert.equal(result.status,400);assert.equal(result.json.code,'invalid_request');
  }
  const install=await call(phoneOrigin,'/api/setup/install-sandbox',{method:'POST',cookie:full,body:{}});
  assert.equal(install.status,409);assert.equal(install.json.code,'platform_unsupported');
  const earlyDenied=await call(phoneOrigin,'/api/update-settings',{method:'POST',cookie:full,body:{earlyBuilds:true}});
  assert.equal(earlyDenied.status,403);assert.equal(earlyDenied.json.code,'local_session_required');
  assert.equal((await call(phoneOrigin,'/api/update-settings',{method:'POST',cookie:full,body:{earlyBuilds:false}})).status,200);
  const earlyOp=await call(phoneOrigin,'/api/ops/update_settings.set',{method:'POST',cookie:full,body:{earlyBuilds:true}});
  assert.equal(earlyOp.status,403);assert.equal(earlyOp.json.code,'local_session_required');
  assert.equal((await call(phoneOrigin,'/api/ops/update_settings.set',{method:'POST',cookie:full,body:{earlyBuilds:false}})).status,200);

  // Person-at-this-computer actions stay on this computer.
  assert.equal((await call(phoneOrigin, '/api/phone/settings', {method: 'POST', cookie: full, body: {enabled: true, address: '127.0.0.1'}})).json.code, 'local_session_required');
  const another = await api(app, '/api/phone/pairing', {method: 'POST', body: {}});
  const remotePairing = await call(phoneOrigin, '/api/phone', {cookie: full});
  assert.equal(remotePairing.json.confirmHere, false, 'remote full access must say confirmation happens on the host');
  assert.equal(remotePairing.json.computer, (await api(app, '/api/devices')).name, 'use the existing computer display name');
  const hostPairing = await api(app, '/api/phone', {token: null, headers: here});
  assert.equal(hostPairing.confirmHere, true, 'the host browser can confirm');
  const confirm = await call(phoneOrigin, '/api/phone/pairing/confirm', {method: 'POST', cookie: full, body: {id: another.pairing.id, confirmed: true}});
  assert.equal(confirm.status, 403);
  assert.equal(confirm.json.code, 'confirm_on_this_computer');
  const cancelled = await call(phoneOrigin, '/api/phone/pairing/cancel', {method: 'POST', cookie: full, body: {id: another.pairing.id}});
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.json.pairing.state, 'cancelled');
  assert.equal(cancelled.json.confirmHere, false);

  // A full phone cannot become the person at this computer: no handoff link, no local session cookie.
  const minted = await call(phoneOrigin, '/api/handoff', {method: 'POST', cookie: full, body: {}});
  assert.equal(minted.status, 403, minted.text);
  const handoffCode = new URL((await api(app, '/api/handoff', {method: 'POST', body: {}})).url).search;
  const redeem = await call(phoneOrigin, '/auth/handoff' + handoffCode, {cookie: full});
  assert.equal(redeem.status, 403, redeem.text);
  assert.ok(!String(redeem.headers['set-cookie'] ?? '').includes('faravan_local_session_'), 'no local session cookie reaches a phone');
  // Even with a local session cookie copied from this computer, a phone request is never a browser session.
  const pending = await api(app, '/api/phone/pairing', {method: 'POST', body: {}});
  const stolen = await call(phoneOrigin, '/api/phone/pairing/confirm', {method: 'POST', cookie: full + '; ' + here.cookie, body: {id: pending.pairing.id, confirmed: true}});
  assert.equal(stolen.status, 403, stolen.text);
  await api(app, '/api/phone/pairing/cancel', {method: 'POST', body: {id: pending.pairing.id}});

  // Guards still hold for a full phone: another site's origin, and a wrong host name.
  assert.equal((await call(phoneOrigin, '/api/lending/limits', {method: 'POST', cookie: full, originHeader: 'https://evil.example', body: {}})).status, 403);
  assert.equal((await call(phoneOrigin, '/api/status', {cookie: full, host: 'evil.example:' + new URL(phoneOrigin).port})).status, 403);

  // Removing the phone ends its app access at once.
  await api(app, '/api/phone/phones/' + paired.id + '/revoke', {method: 'POST', body: {}});
  assert.equal((await call(phoneOrigin, '/api/status', {cookie: full})).status, 404);
  const after = await call(phoneOrigin, '/', {cookie: full});
  assert.equal(after.text, phonePage.text, 'a removed phone sees the phone page again');
});

test('cancelling a pairing names it: a stale id leaves a newer pairing alone, and no id is refused', testOptions, async t => {
  const f = await appFixture(t);
  const {app} = await f.start('phone-cancel', {networkInterfaces});
  const here = {cookie: await browserCookie(app), origin: new URL(app.origin).origin};
  await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here, body: {enabled: true, address: '127.0.0.1'}});

  const older = await api(app, '/api/phone/pairing', {method: 'POST', body: {}});
  await api(app, '/api/phone/pairing/cancel', {method: 'POST', body: {id: older.pairing.id}});
  const newer = await api(app, '/api/phone/pairing', {method: 'POST', body: {}});

  // (a) a stale id names a pairing that is no longer current: the newer pairing stays in place.
  const stale = await api(app, '/api/phone/pairing/cancel', {method: 'POST', body: {id: older.pairing.id}});
  assert.equal(stale.pairing.id, newer.pairing.id);
  assert.equal(stale.pairing.state, 'waiting');

  // (b) no id is refused and changes nothing.
  const bare = await api(app, '/api/phone/pairing/cancel', {method: 'POST', body: {}, status: 400});
  assert.equal(bare.code, 'invalid_request');
  const after = await api(app, '/api/phone');
  assert.equal(after.pairing.id, newer.pairing.id);
  assert.equal(after.pairing.state, 'waiting');

  const cancelled = await api(app, '/api/phone/pairing/cancel', {method: 'POST', body: {id: newer.pairing.id}});
  assert.equal(cancelled.pairing.state, 'cancelled');
});

test('Tailscale HTTPS: tailscale serve forwards to a loopback listener; the phone pairs and gets the full app over HTTPS', testOptions, async t => {
  const served = new Map(), calls = [];
  const tailscale = {
    async self() { return {dnsName: 'box.tail1234.ts.net', addresses: ['100.101.1.2']}; },
    async served(port) { return served.get(port) ?? null; },
    async serve(port, target) { calls.push(['serve', port, target]); served.set(port, target); },
    async unserve(port) { calls.push(['unserve', port]); served.delete(port); },
  };
  const f = await appFixture(t);
  const {app} = await f.start('phone-tailscale', {networkInterfaces, tailscale});
  const here = {cookie: await browserCookie(app), origin: new URL(app.origin).origin};

  // Another program already serves the port: Faravan never takes it over.
  served.set(9443, 'http://127.0.0.1:1');
  const taken = await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here, body: {enabled: true, tailscaleHttps: true}});
  assert.equal(taken.reach.state, 'problem');
  assert.match(taken.reach.facts[0], /already serves another program on port 9443/);
  assert.deepEqual(calls, []);
  served.delete(9443);
  assert.equal((await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here,
    body: {enabled: true, tailscaleHttps: true, address: '127.0.0.1'}, status: 400})).code, 'invalid_request');

  const on = await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here, body: {enabled: true, tailscaleHttps: true}});
  assert.equal(on.tailscaleHttps, true);
  assert.equal(on.origin, 'https://box.tail1234.ts.net:9443');
  assert.equal(on.reach.state, 'https');
  assert.equal(on.fullAvailable, true);
  const [, port, target] = calls.at(-1);
  assert.equal(port, 9443);
  assert.match(target, /^http:\/\/127\.0\.0\.1:\d+$/, 'the listener is on loopback only; tailscale serve is the way in');

  // What tailscale serve sends: the ts.net Host, the https Origin and the phone's tailnet address.
  const phone = (path, opts = {}) => call(target, path, {...opts, host: opts.host ?? 'box.tail1234.ts.net:9443',
    originHeader: opts.originHeader ?? (opts.method === 'POST' ? on.origin : undefined), headers: {'x-forwarded-for': '100.64.9.9, 100.64.0.10'}});
  const started = await api(app, '/api/phone/pairing', {method: 'POST', body: {access: 'full'}});
  assert.ok(started.pairing.url.startsWith(on.origin + '/pair#'));
  const claim = await phone('/phone/api/pair/claim', {method: 'POST', body: {code: started.pairing.code, label: 'Pixel'}});
  assert.equal(claim.status, 200, claim.text);
  assert.ok(claim.json.scopes.includes('requests:answer') && claim.json.scopes.includes('app:full'), 'HTTPS scopes plus the full app');
  assert.match(claim.headers['set-cookie'].join(';'), /Secure/, 'the phone sees HTTPS, so cookies are Secure');
  const waiting = await api(app, '/api/phone');
  assert.equal(waiting.pairing.phone.address, '100.64.0.10', 'the computer shows the peer tailscale serve appended, not a value the client sent');
  await api(app, '/api/phone/pairing/confirm', {method: 'POST', token: null, headers: here, body: {id: waiting.pairing.id, confirmed: true}});
  const done = await phone('/phone/api/pair/status', {cookie: cookieOf(claim)});
  assert.equal(done.json.state, 'paired', done.text);
  assert.equal(done.json.full, true);
  const full = cookieOf(done);

  const status = await phone('/api/status', {cookie: full});
  assert.equal(status.status, 200, status.text);
  assert.equal((await phone('/api/status', {cookie: full, host: '127.0.0.1:' + new URL(target).port})).status, 403, 'only the ts.net name is accepted');
  assert.equal((await phone('/api/lending/limits', {method: 'POST', cookie: full, originHeader: 'http://box.tail1234.ts.net:9443', body: {}})).status, 403);

  // Turning phone access off removes the serve entry, so nothing forwards to a closed port.
  const off = await api(app, '/api/phone/settings', {method: 'POST', body: {enabled: false}});
  assert.equal(off.enabled, false);
  assert.deepEqual(calls.at(-1), ['unserve', 9443]);
  assert.equal(served.size, 0);
});

test('a full phone signs in to Codex: the pasted redirect address is replayed on the app computer, not on the phone', {...testOptions, skip: process.platform === 'win32'}, async t => {
  const sbxHome = await mkdtemp(join(tmpdir(), 'phone-codex-'));
  const saved = {home: process.env.FARAVAN_SBX_HOME, root: process.env.FARAVAN_SCRATCH_ROOT};
  process.env.FARAVAN_SBX_HOME = sbxHome; process.env.FARAVAN_SCRATCH_ROOT = sbxHome;
  t.after(() => { for (const [name, value] of [['FARAVAN_SBX_HOME', saved.home], ['FARAVAN_SCRATCH_ROOT', saved.root]]) value === undefined ? delete process.env[name] : process.env[name] = value; });
  const port = await freePort(), fake = await fakeCodex(sbxHome, port);
  const f = await appFixture(t);
  const {app} = await f.start('phone-codex', {networkInterfaces, signin: {
    adapters: async () => [{spec: CODEX_HARNESS}], guard: async () => {},
    startProvider: (spec, {onHandle, method}) => startProviderGenerationAuth(spec, {home: sbxHome, providerBin: fake.bin, onHandle, method})}});
  const dir = await f.home('phone-codex');
  const here = {cookie: await browserCookie(app), origin: new URL(app.origin).origin};
  const key = join(dir, 'phone-key.pem'), cert = join(dir, 'phone-cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '1',
    '-subj', '/CN=faravan.test', '-keyout', key, '-out', cert], {stdio: 'ignore'});
  const on = await api(app, '/api/phone/settings', {method: 'POST', token: null, headers: here, body: {enabled: true, address: '127.0.0.1', certFile: cert, keyFile: key}});
  const full = await pairPhone(app, on.origin, {access: 'full'});

  const started = await call(on.origin, '/api/signin/' + CODEX_HARNESS.harness_id, {method: 'POST', cookie: full, body: {method: 'browser'}});
  assert.equal(started.status, 200, started.text);
  assert.equal(started.json.status, 'awaiting_browser');
  assert.equal(started.json.redirectEntry, true, 'the phone is offered the paste field');
  const pasted = 'http://localhost:' + port + '/auth/callback?code=' + CODE + '&state=' + STATE;
  const wrong = await call(on.origin, '/api/signin/' + started.json.flowId + '/code', {method: 'POST', cookie: full, body: {code: pasted.replace(STATE, 'other')}});
  assert.equal(wrong.status, 400); assert.equal(wrong.json.code, 'signin_redirect_mismatch');
  assert.equal(await readFile(fake.log, 'utf8').catch(() => ''), '', 'a wrong state reaches no listener');
  const sent = await call(on.origin, '/api/signin/' + started.json.flowId + '/code', {method: 'POST', cookie: full, body: {code: pasted}});
  assert.equal(sent.status, 200, sent.text);
  await waitFor(async () => (await call(on.origin, '/api/signin/' + started.json.flowId, {cookie: full})).json?.status === 'complete', 'sign-in completes', 15000);
  assert.match(await readFile(fake.log, 'utf8'), /^\/auth\/callback\?code=ac_synthetic_code&state=state-abc123\n$/, 'the CLI listener on this computer got the callback');
});

test('phone start and polling receipts carry decreasing remaining code lifetime', testOptions, async t => {
  let time=Date.now();
  const f=await appFixture(t);
  const {app}=await f.start('phone-expiry',{networkInterfaces,signin:{now:()=>time,
    startDocker:async()=>({status:'awaiting-browser',url:'https://login.docker.com/activate',code:'ABCD-1234',expiresAt:time+60_000,
      waitForCompletion:()=>new Promise(()=>{}),cancel(){}})}});
  const here={cookie:await browserCookie(app),origin:new URL(app.origin).origin};
  const dir=await f.home('phone-expiry');
  const key=join(dir,'phone-key.pem'),cert=join(dir,'phone-cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','ec','-pkeyopt','ec_paramgen_curve:prime256v1','-nodes','-days','1','-subj','/CN=faravan.test','-keyout',key,'-out',cert],{stdio:'ignore'});
  const on=await api(app,'/api/phone/settings',{method:'POST',token:null,headers:here,body:{enabled:true,address:'127.0.0.1',certFile:cert,keyFile:key}});
  const phone=await pairPhone(app,on.origin,{access:'full'});
  const started=await call(on.origin,'/api/signin/docker',{method:'POST',cookie:phone,body:{}});
  assert.equal(started.json.expiresInMs,60_000,'phone start');
  time+=1000;
  const polled=await call(on.origin,'/api/signin/'+started.json.flowId,{cookie:phone});
  assert.equal(polled.json.expiresInMs,59_000,'phone polling');
});
