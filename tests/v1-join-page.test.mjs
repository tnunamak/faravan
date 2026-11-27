import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createHash, generateKeyPairSync, sign, webcrypto, randomBytes, randomUUID } from 'node:crypto';
import * as p from '../lib/protocol/index.mjs';
import { forgeries } from './helpers/v1-short-invite.mjs';
import { startApp } from '../lib/v1/app.mjs';
import { createV1Handler } from '../lib/v1/server.mjs';

// Hermetic local transport and a tiny DOM double; no browser, provider or real enrollment.
const page = readFileSync(new URL('../public/join/index.html', import.meta.url), 'utf8');
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
const encode = value => Buffer.from(value).toString('base64url');
function invitation(name, lanMode, expiresAt = '2099-10-10T00:00:00Z') {
  return '#invite=' + encode(JSON.stringify({
    invite: { payload: {
      schema: 'faravan.invite.v1', circle: '00000000-0000-4000-8000-000000000000',
      coordinator: 'http://127.0.0.1:1234', root_fingerprint: 'sha256:' + 'a'.repeat(64),
      root_public_key: encode(Buffer.alloc(32)), invite_public_key: encode(Buffer.alloc(32)),
      invite_id: '00000000-0000-4000-8000-000000000001',
      created_at: '2026-10-09T00:00:00Z', expires_at: expiresAt,
      ...(name === undefined ? {} : { display_name: name }),
      ...(lanMode === undefined ? {} : { lan_mode: lanMode }),
    }, signature: { algorithm: 'Ed25519', key_id: 'sha256:' + 'a'.repeat(64), value: encode(Buffer.alloc(64)) } },
    invite_private_seed: encode(Buffer.alloc(32)),
  }));
}
function render(fragment, clipboardWorks = true, source = script, extra = {}) {
  const elements = new Map(), copied = [], history = [];
  function element(id) {
    if (!elements.has(id)) elements.set(id, {
      textContent: '', hidden: true, disabled: id === 'copy', value: '', handlers: {},
      addEventListener(event, callback) { this.handlers[event] = callback; },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      focus() { this.focused = true; }, select() { this.selected = true; },
    });
    return elements.get(id);
  }
  const pathname = extra.pathname ?? '/join', origin = extra.origin ?? 'http://127.0.0.1:1234';
  const href = origin + pathname + fragment;
  const context = {
    document: { getElementById: element },
    location: { href, hash: fragment, pathname, origin },
    history: { replaceState(...args) { history.push(args); } },
    navigator: { ...extra.navigator, clipboard: { async writeText(value) {
      if (!clipboardWorks) throw new Error('Unavailable');
      copied.push(value);
    } } },
    atob: value => Buffer.from(value, 'base64').toString('binary'),
    btoa: value => Buffer.from(value, 'binary').toString('base64'),
    TextDecoder, TextEncoder, Uint8Array, JSON, Date, Object, String, Array, Number, Error, Promise,
    AbortController, setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout,
    ...extra.globals,
  };
  runInNewContext(source, context);
  return { element, copied, history, href, ready: context.faravanJoinReady, context };
}

test('GET /join and GET /i/<code> are public, self-contained and protected; no other public page is added', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'faravan-join-test-'));
  const store = {
    configuration: () => ({ origin: 'http://127.0.0.1:1234', circle: 'test-circle', limits: { maxArtifactBytes: 1024 } }),
    recoverTransportUploads() {},
    collect() {},
  };
  const handler = createV1Handler({ store, blobDir: join(dir, 'blobs') });
  const server = createServer(handler);
  t.after(async () => {
    handler.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const get = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject); req.end();
  });
  const res = await get('/join');
  assert.equal(res.status, 200);
  assert.equal(res.body, page);
  assert.equal(res.headers['content-type'], 'text/html; charset=utf-8');
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(res.headers['content-security-policy'].includes(directive));
  assert.doesNotMatch(page, /https?:\/\/|(?:src|href|action)\s*=\s*["']\/\/|url\(\s*["']?\/\//i);
  assert.doesNotMatch(page, /\b(?:src|action)\s*=|\b(?:XMLHttpRequest|WebSocket|sendBeacon|localStorage|sessionStorage|eval)\b/i);
  // The only request the page can make is the same-origin read of the published invitation.
  assert.deepEqual([...page.matchAll(/\bfetch\(([^,)]*)/g)].map(match => match[1]), ["'/v1/invites/' + shortCode"]);
  assert.match(res.headers['content-security-policy'], /connect-src 'none'/);
  const short = await get('/i/abcde23456');
  assert.equal(short.status, 200);
  assert.equal(short.body, page);
  assert.match(short.headers['content-security-policy'], /connect-src 'self'/);
  assert.doesNotMatch(short.headers['content-security-policy'], /connect-src 'none'/);
  for (const header of ['referrer-policy', 'cache-control', 'x-content-type-options']) assert.equal(short.headers[header], res.headers[header]);
  for (const directive of ["default-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-ancestors 'none'"]) assert.ok(short.headers['content-security-policy'].includes(directive));
  for (const path of ['/i/', '/i', '/i/abcde2345', '/i/abcde234567', '/i/ABCDE23456', '/i/abcde23458', '/i/abcde23456/', '/i/abcde23456?x=1', '/i/abcde23456/extra']) assert.equal((await get(path)).status, 404, path);
  for (const method of ['HEAD', 'POST', 'PUT']) assert.equal((await get('/i/abcde23456', method)).status, 404);
  assert.deepEqual([...page.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"']*)["']/g)].map(match => match[1]), ['#install']);
  for (const path of ['/unknown', '/join/', '/join?invite=secret', '/join/index.html']) assert.equal((await get(path)).status, 404);
  for (const method of ['HEAD', 'POST', 'PUT']) assert.equal((await get('/join', method)).status, 404);
});

test('decoded display name is labelled unverified plain text, with no copy before a click', async () => {
  const name = '<img src=x onerror=alert(1)>', view = render(invitation(name));
  assert.equal(view.element('heading').textContent, "You're invited to the Faravan circle " + name + ' (unverified).');
  assert.equal(page.split('Faravan checks this invitation when you open it in the app.').length - 1, 1);
  assert.match(view.element('heading').textContent, /\(unverified\)\.$/);
  assert.ok(page.includes("Check with the person who invited you if you weren't expecting this invitation."));
  assert.ok(page.includes('Keep this invitation private.'));
  assert.match(page, /id="status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(page, /<section id="paste"[\s\S]*?<button[^>]*id="copy"[^>]*>Copy invitation<\/button>[\s\S]*?<\/section>/);
  assert.equal(view.copied.length, 0);
  assert.equal(view.element('copy').disabled, false);
  assert.equal(view.history[0][2], '/join');
  await view.element('copy').handlers.click();
  assert.deepEqual(view.copied, [view.href]);
  assert.equal(view.element('status').textContent, 'Invitation copied. Open Faravan and paste it into “Invitation”.');
  view.element('get').handlers.click({ preventDefault() {} });
  assert.equal(view.element('install').hidden, false);
  assert.equal(view.element('install').focused, true);
  // "I already have Faravan" is a real link to the app; the paste steps open alongside it as the fallback.
  assert.equal(view.element('open').href, 'faravan://join?link=' + encodeURIComponent(view.href));
  view.element('open').handlers.click();
  assert.equal(view.element('paste').hidden, false);
  assert.equal(view.element('open')['aria-expanded'], 'true');
  assert.match(view.element('status').textContent, /Opening Faravan\. If nothing happens/);
});


const devices = [
  { name: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', phone: true },
  { name: 'Android', userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9) Mobile', phone: true },
  { name: 'macOS', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' },
  { name: 'Windows', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', windows: true },
  { name: 'Linux', userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' },
  { name: 'iPadOS', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15)', maxTouchPoints: 5, phone: true },
  { name: 'mobile client hints', userAgent: '', userAgentData: { mobile: true, platform: 'Linux' }, phone: true },
  { name: 'Android client hints', userAgent: '', userAgentData: { mobile: false, platform: 'Android' }, phone: true },
  { name: 'Windows client hints', userAgent: '', userAgentData: { mobile: false, platform: 'Windows' }, windows: true },
  { name: 'macOS client hints', userAgent: '', userAgentData: { mobile: false, platform: 'macOS' } },
  { name: 'Linux client hints', userAgent: '', userAgentData: { mobile: false, platform: 'Linux' } },
];
for (const device of devices) test('device-aware join action: ' + device.name, () => {
  const view = render(invitation(), true, script, { navigator: device });
  const desktop = !device.phone && !device.windows;
  assert.equal(view.element('get').hidden, !desktop);
  assert.equal(view.element('open').hidden, !desktop);
  assert.equal(view.element('install').hidden, !desktop);
  assert.equal(view.element('download-note').hidden, !desktop);
  assert.equal(view.element('email').hidden, !device.phone);
  assert.doesNotMatch(page, /Download coming soon|Ask the person who invited you for the Faravan installer\./);
  assert.equal(view.copied.length, 0);
  assert.equal(view.element('invitation').value, '');
  assert.equal(view.history[0][2], '/join');
  if (device.phone) {
    assert.equal(view.element('device-note').textContent, 'Faravan runs on a computer for now. Open this link on your Mac or Linux computer to join.');
    const email = new URL(view.element('email').href);
    assert.equal(email.protocol, 'mailto:');
    assert.equal(email.pathname, '');
    assert.equal(email.searchParams.get('body'), view.href + '\n\nKeep this link private; it lets someone join your circle.');
    assert.equal(view.element('open').href, '#paste');
  } else if (device.windows) {
    assert.match(view.element('device-note').textContent, /Lending isn't available on Windows yet\./);
    assert.equal(view.element('email').href, undefined);
  } else {
    assert.match(page, /id="get"[^>]*>How to join</);
    assert.match(page, /id="download-note" class="muted"[^>]*>Installer coming soon</);
    assert.equal(view.element('get').href, '#install');
    let prevented = false;
    view.element('get').handlers.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(view.element('install').focused, true);
    assert.equal(view.history.length, 1);
    assert.equal(view.element('email').href, undefined);
  }
});

test('phone mailto preserves a verified short link and stays unavailable for invalid invitations', async () => {
  const navigator = { userAgent: devices[0].userAgent };
  const view = await renderShort(shortFixture(), { globals: { navigator } });
  assert.equal(new URL(view.element('email').href).searchParams.get('body'),
    view.href + '\n\nKeep this link private; it lets someone join your circle.');
  assert.ok(view.href.includes('#' + SEED_TEXT));
  const bad = render('#invite=bad!', true, script, { navigator });
  assert.equal(bad.element('email').hidden, true);
  assert.equal(bad.element('email').href, undefined);
  const failed = await renderShort(shortFixture(), { answer: { status: 410 }, globals: { navigator } });
  assert.equal(failed.element('email').hidden, true);
  assert.equal(failed.element('email').href, undefined);
});

test('invitation copy welcomes borrowing and lending without changing the protocol', () => {
  assert.ok(page.includes("Ask friends' coding agents to do a task for you, or lend yours when you're not using it. Jobs run in a private sandbox on the lender's computer."));
  assert.match(page, /id="heading">You're invited to a Faravan circle</);
});

test('self-contained styles include app tokens, focus, dark mode and narrow-screen layout', () => {
  assert.match(page, /font-family:Inter,ui-sans-serif,system-ui,sans-serif/);
  assert.match(page, /background:#19597e/);
  assert.match(page, /min-height:44px/);
  assert.match(page, /:focus-visible/);
  assert.match(page, /@media\(prefers-color-scheme:dark\)/);
  assert.match(page, /@media\(max-width:650px\)/);
  assert.match(page, /overflow-wrap:anywhere/);
  assert.match(page, /\.actions\{flex-direction:column\}/);
});

test('missing, malformed, duplicate, bad UTF-8 and oversized fragments have the exact remedy', () => {
  for (const fragment of ['', '#', '#invite=', '#invite=bad!', '#invite=abcd&invite=abcd',
    '#invite=' + 'a'.repeat(32768), '#invite=' + encode('{}'), '#invite=' + encode(Buffer.from([255]))]) {
    const view = render(fragment);
    assert.match(view.element('status').textContent, /Ask the person who invited you for a new link$/);
    assert.equal(view.element('copy').disabled, true);
    assert.equal(view.copied.length, 0);
    assert.equal(view.history[0][2], '/join');
  }
  assert.equal(render(invitation()).element('copy').disabled, false);
});

test('expired long invitations are disabled, and invalid expiry dates are malformed', () => {
  const expired = render(invitation('Old circle', undefined, '2000-01-01T00:00:00Z'));
  assert.match(expired.element('status').textContent, /This invitation has expired/);
  assert.equal(expired.element('copy').disabled, true);
  assert.equal(expired.element('open').href, '#paste');
  assert.equal(expired.element('role').hidden, true);
  assert.equal(expired.element('email').hidden, true);
  assert.equal(expired.history[0][2], '/join');

  const invalid = render(invitation('Old circle', undefined, 'not a date'));
  assert.match(invalid.element('status').textContent, /malformed/);
  assert.equal(invalid.element('copy').disabled, true);
});

test('clipboard failure offers the full link for manual copying only after a click', async () => {
  const view = render(invitation('Test circle'), false);
  assert.equal(view.element('invitation').value, '');
  await view.element('copy').handlers.click();
  assert.equal(view.element('manual').hidden, false);
  assert.equal(view.element('invitation').value, view.href);
  assert.equal(view.element('invitation').selected, true);
  assert.equal(view.copied.length, 0);
  assert.equal(view.element('status').textContent, 'Automatic copying is unavailable. Copy the selected invitation, then paste it into Faravan.');
});

const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
    : '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical(value[key])).join(',') + '}'
  : JSON.stringify(value);
function signedInvitation({lan = false, expired = false, name = 'Weekend projects', expiresAt} = {}) {
  const root = generateKeyPairSync('ed25519'), invitationKey = generateKeyPairSync('ed25519');
  const publicBytes = root.publicKey.export({format:'der', type:'spki'}).subarray(-32);
  const fingerprint = 'sha256:' + createHash('sha256').update(publicBytes).digest('hex');
  const origin = lan ? 'http://10.23.1.2:4000' : 'https://circle.example';
  const payload = {
    schema:'faravan.invite.v1', circle:'00000000-0000-4000-8000-000000000000',
    coordinator:origin, root_fingerprint:fingerprint, root_public_key:encode(publicBytes),
    invite_id:'00000000-0000-4000-8000-000000000001',
    invite_public_key:encode(invitationKey.publicKey.export({format:'der', type:'spki'}).subarray(-32)),
    created_at:'2026-10-09T09:00:00Z', expires_at:expired?'2026-10-09T09:30:00Z':(expiresAt ?? '2026-10-10T09:00:00Z'),
    display_name:name, ...(lan?{lan_mode:true}:{}),
  };
  const bytes = Buffer.concat([Buffer.from('faravan/invite/v1\0'),createHash('sha256').update(canonical(payload)).digest()]);
  const invite = {payload,signature:{algorithm:'Ed25519',key_id:fingerprint,value:encode(sign(null,bytes,root.privateKey))}};
  const seed = encode(invitationKey.privateKey.export({format:'der',type:'pkcs8'}).subarray(-32));
  return {link:origin+'/join#invite='+encode(canonical({invite,invite_private_seed:seed})),seed,invite};
}
test('LAN notice markup is shown only for a decoded invitation with lan_mode true', () => {
  const warning = 'This circle uses your local network without encryption; people on the same network could read uploaded code.';
  assert.ok(page.includes('<p id="lan-notice" class="note" hidden>' + warning + '</p>'));
  const lan = signedInvitation({ lan: true, expiresAt: '2099-10-10T09:00:00Z' });
  assert.equal(render(lan.link.slice(lan.link.indexOf('#'))).element('lan-notice').hidden, false);
  assert.equal(render(invitation('LAN circle', true)).element('lan-notice').hidden, false);
  for (const lanMode of [undefined, false, 'true', 1]) {
    assert.equal(render(invitation('Other circle', lanMode)).element('lan-notice').hidden, true);
  }
  assert.equal(render('#invite=bad!').element('lan-notice').hidden, true);
  assert.equal(render('').element('lan-notice').hidden, true);
});

test('local app previews signed invites without enrollment and requires explicit LAN warning consent', async t => {
  const home = mkdtempSync(join(tmpdir(),'faravan-join-app-')),joined=[];
  let current = Date.parse('2026-10-09T10:00:00Z');
  const device = {keyId:'test-device',listCircles:async()=>[],
    joinCircle:async link=>{
      const fragment=link.slice(link.indexOf('#invite=')+8),payload=JSON.parse(Buffer.from(fragment,'base64url').toString()).invite.payload;
      if(Date.parse(payload.expires_at)<=current)throw Object.assign(new Error('invitation_expired'),{code:'invitation_expired',status:410});
      joined.push(link);return {id:'circle',name:'Weekend projects',enrollment:{state:'pending'}};
    }};
  const app = await startApp({home,device,clock:{now:()=>current},backendFactory:()=>({}),adapters:[],
    pollMs:60000,fetch:()=>assert.fail('No external request is allowed in this fixture')});
  t.after(async()=>{await app.close();rmSync(home,{recursive:true,force:true});});
  const post = (path,body) => new Promise((resolve,reject)=>{
    const req=request({hostname:'127.0.0.1',port:app.server.address().port,path:'/api/circles/'+path,method:'POST',
      headers:{'content-type':'application/json','x-faravan-session-token':app.token}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>{
        const text=Buffer.concat(chunks).toString();resolve({status:res.statusCode,text,body:JSON.parse(text)});
      });
    });req.on('error',reject);req.end(JSON.stringify(body));
  });
  const lan=signedInvitation({lan:true}),secure=signedInvitation();
  const warning='This circle uses your local network without encryption; people on the same network could read uploaded code.';
  const preview=await post('join-preview',{link:lan.link});
  assert.equal(preview.status,200);assert.equal(preview.body.name,'Weekend projects');
  assert.equal(preview.body.lanMode,true);assert.equal(preview.body.warning,warning);
  assert.equal(preview.body.origin,'http://10.23.1.2:4000');
  assert.equal(joined.length,0);
  assert.ok(!preview.text.includes(lan.seed));assert.ok(!preview.text.includes(lan.link));
  for(const acknowledgedWarning of [undefined,false,'true',1]) {
    const denied=await post('join',{link:lan.link,acknowledgedWarning,lanMode:false});
    assert.equal(denied.status,409);assert.equal(denied.body.code,'warning_not_acknowledged');
    assert.equal(denied.body.warning,warning);assert.equal(denied.body.message,warning);
    assert.equal(joined.length,0);
  }
  assert.equal((await post('join',{link:lan.link,acknowledgedWarning:true})).status,200);
  assert.deepEqual(joined,[lan.link]);
  const strictPreview=await post('join-preview',{link:secure.link});
  assert.equal(strictPreview.body.lanMode,false);assert.equal(strictPreview.body.warning,null);
  assert.equal((await post('join',{link:secure.link})).status,200);
  assert.deepEqual(joined,[lan.link,secure.link]);
  const forged=JSON.parse(Buffer.from(lan.link.split('#invite=')[1],'base64url').toString());
  forged.invite.payload.display_name='Forged circle';
  const forgedLink='http://10.23.1.2:4000/join#invite='+encode(canonical(forged));
  for(const link of ['malformed',signedInvitation({expired:true}).link,forgedLink]) {
    for(const path of ['join-preview','join']) assert.ok((await post(path,{link,acknowledgedWarning:true})).status>=400);
  }
  // A successful preview does not grandfather an invitation past its expiry.
  current=Date.parse('2026-10-11T00:00:00Z');
  assert.ok((await post('join',{link:lan.link,acknowledgedWarning:true})).status>=400);
  assert.equal(joined.length,2);
});

// --- /i/<code>#<seed>: the page checks the published invitation with the link's own seed -----------------------

const SEED = Buffer.alloc(32, 9), SEED_TEXT = SEED.toString('base64url');
function shortFixture({ ownerName = 'Tessa', name = 'Critics', seed = SEED, expires = 'in the future', role, max_uses } = {}) {
  const root = p.generateRootKeyPair().privateKey, key = p.privateKeyFromSeed(seed);
  const now = Math.floor(Date.now() / 1000), at = n => new Date(n * 1000).toISOString().replace('.000Z', 'Z');
  const envelope = p.createInvite({ circle: randomUUID(), coordinator: 'http://127.0.0.1:1234', invite_id: randomUUID(),
    invite_public_key: p.exportPublicKey(key), created_at: at(now - 60), expires_at: expires === 'in the future' ? at(now + 3600) : expires,
    ...(role === undefined ? {} : {role}), ...(max_uses === undefined ? {} : {max_uses}),
    ...(name === null ? {} : { display_name: name }), ...(ownerName === null ? {} : { owner_name: ownerName }) }, root);
  return { code: 'abcde23456', envelope, invite_binding: p.createInviteBinding(envelope, key) };
}
// A fetch double for the page: records every call and answers like the coordinator does.
function respond(publication, { status = 200, body } = {}) {
  const calls = [];
  const fetch = async (...args) => {
    calls.push(args);
    const text = body ?? JSON.stringify({ envelope: publication.envelope, invite_binding: publication.invite_binding });
    return { status, ok: status >= 200 && status < 300, text: async () => text };
  };
  return { fetch, calls };
}
async function renderShort(publication, { seed = SEED_TEXT, answer = {}, globals = {} } = {}) {
  const net = respond(publication, answer);
  const view = render('#' + seed, true, script, { pathname: '/i/' + publication.code,
    globals: { fetch: net.fetch, crypto: webcrypto, ...globals } });
  await view.ready;
  return { ...view, calls: net.calls, heading: view.element('heading').textContent, status: view.element('status').textContent,
    identity: view.element('identity').textContent };
}
const FAILED = 'This invitation can’t be verified.';

test('short link: a verified invitation names the owner and the circle, and the deep link opens the app', async () => {
  const view = await renderShort(shortFixture());
  assert.equal(view.heading, 'Tessa invited you to Critics.');
  assert.match(view.identity, /^Checked in this browser/);
  assert.equal(view.element('open').href, 'faravan://join?link=' + encodeURIComponent(view.href));
  assert.equal(new URL(view.element('open').href).searchParams.get('link'), view.href);
  assert.equal(view.element('copy').disabled, false);
  assert.equal(view.status, '');
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0][2], '/i/abcde23456', 'the seed is removed from the address bar');
  // The page asks its own origin for exactly the code and sends neither the seed nor any credential.
  assert.equal(view.calls.length, 1);
  assert.equal(view.calls[0][0], '/v1/invites/abcde23456');
  assert.equal(view.calls[0][1].credentials, 'omit');
  assert.equal(view.calls[0][1].redirect, 'error');
  assert.ok(!JSON.stringify(view.calls).includes(SEED_TEXT));
  await view.element('copy').handlers.click();
  assert.deepEqual(view.copied, [view.href]);
});

test('short link: owner and circle names are plain text, whatever they contain', async () => {
  const hostile = '<img src=x onerror=alert(1)>';
  const view = await renderShort(shortFixture({ ownerName: hostile, name: '</script><b>"Q" \\ 😀 Zoë' }));
  assert.equal(view.heading, hostile + ' invited you to </script><b>"Q" \\ 😀 Zoë.');
  assert.equal(view.element('heading').innerHTML, undefined, 'only textContent is ever written');
});

test('short link: without an owner name the heading is generic; without a circle name it says a circle', async () => {
  assert.equal((await renderShort(shortFixture({ ownerName: null }))).heading, "You're invited to the Faravan circle Critics");
  assert.equal((await renderShort(shortFixture({ ownerName: null, name: null }))).heading, "You're invited to a Faravan circle");
  assert.equal((await renderShort(shortFixture({ name: null }))).heading, 'Tessa invited you to their Faravan circle.');
});

test('short link: a browser that cannot verify Ed25519 never shows invitation names', async () => {
  const unsupported = { ...webcrypto, subtle: Object.create(webcrypto.subtle, { importKey: { value: async () => { throw new Error('NotSupportedError'); } } }) };
  for (const globals of [{ crypto: unsupported }, { crypto: undefined }]) {
    const view = await renderShort(shortFixture(), { globals });
    assert.equal(view.heading, "You're invited to a Faravan circle");
    assert.ok(!view.heading.includes('Tessa'));
    assert.ok(!view.heading.includes('Critics'));
    assert.match(view.identity, /can’t check the invitation itself/);
    assert.equal(view.element('copy').disabled, false, 'the app still checks it');
    assert.match(view.element('open').href, /^faravan:\/\/join\?link=/);
  }
  const invalidExpiry = shortFixture();
  invalidExpiry.envelope.payload.expires_at = 'not a date';
  const invalid = await renderShort(invalidExpiry, { globals: { crypto: undefined } });
  assert.equal(invalid.heading, FAILED);
  assert.match(invalid.status, /can’t be trusted/);
  assert.equal(invalid.element('copy').disabled, true);
});

test('short link: malformed publications reach the remedy even without browser crypto', async () => {
  const real = shortFixture();
  const unsupported = { subtle: { importKey: async () => { throw new Error('NotSupportedError'); } } };
  const malformed = [{}, null, [], { envelope: null, invite_binding: real.invite_binding },
    { envelope: real.envelope }, { envelope: real.envelope, invite_binding: {} },
    { envelope: real.envelope, invite_binding: { algorithm: 'Ed25519', value: 'bad' } }];
  for (const crypto of [undefined, unsupported, webcrypto]) {
    for (const publication of malformed) {
      const view = await renderShort(real, { answer: { body: JSON.stringify(publication) }, globals: { crypto } });
      assert.equal(view.heading, FAILED);
      assert.match(view.status, /Ask the person who invited you for a new link/);
      assert.equal(view.element('copy').disabled, true);
      assert.equal(view.element('open').href, '#paste');
    }
  }
});

test('short link: every forgery a coordinator can make shows an error, no names and no way to continue', async () => {
  const real = shortFixture();
  for (const { label, publication } of forgeries({ envelope: real.envelope, invite_binding: real.invite_binding })) {
    const view = await renderShort({ code: real.code, ...publication });
    assert.equal(view.heading, FAILED, label);
    assert.match(view.status, /can’t be trusted/, label);
    assert.ok(!/Tessa|Critics/.test(view.heading + view.status + view.identity), label + ': no unverified name is shown');
    assert.equal(view.element('copy').disabled, true, label);
    assert.equal(view.element('open').href, '#paste', label);
    assert.equal(view.element('lan-notice').hidden, true, label);
  }
  // Right invitation, wrong seed in the fragment: the link does not match the invitation.
  const wrongSeed = await renderShort(real, { seed: randomBytes(32).toString('base64url') });
  assert.equal(wrongSeed.heading, FAILED);
  // A binding that was valid for another invitation is refused.
  const other = shortFixture();
  assert.equal((await renderShort({ ...real, invite_binding: other.invite_binding })).heading, FAILED);
  // The invitation says another origin.
  const moved = await renderShort(real, { globals: {} });
  assert.equal(moved.heading, 'Tessa invited you to Critics.');
  const view = render('#' + SEED_TEXT, true, script, { pathname: '/i/abcde23456', origin: 'https://elsewhere.example',
    globals: { fetch: respond(real).fetch, crypto: webcrypto } });
  await view.ready;
  assert.equal(view.element('heading').textContent, FAILED);
});

test('short link: not found, expired, unreachable and malformed answers each have their own remedy', async () => {
  const real = shortFixture();
  const missing = await renderShort(real, { answer: { status: 404, body: '{}' } });
  assert.match(missing.status, /was not found/);
  const expired = await renderShort(real, { answer: { status: 410, body: '{}' } });
  assert.match(expired.status, /has expired/);
  const down = await renderShort(real, { answer: { status: 503, body: '{}' } });
  assert.match(down.status, /Could not reach this server/);
  const thrown = await renderShort(real, { globals: { fetch: async () => { throw new Error('offline'); } } });
  assert.match(thrown.status, /Could not reach this server/);
  const junk = await renderShort(real, { answer: { body: 'not json' } });
  assert.match(junk.status, /Could not reach this server/);
  const huge = await renderShort(real, { answer: { body: ' '.repeat(16385) } });
  assert.match(huge.status, /Could not reach this server/);
  for (const view of [missing, expired, down, thrown, junk, huge]) {
    assert.equal(view.element('copy').disabled, true);
    assert.equal(view.element('open').href, '#paste');
    assert.equal(view.heading, '', 'the generic static heading stays: no name is written without a verified answer');
  }
  assert.equal(down.element('retry').hidden, false);
  assert.match(down.status, /Open the original invitation link again/);
  assert.equal(missing.element('retry').hidden, true);
  assert.equal(expired.element('retry').hidden, true);
  for (const fragment of ['', '#', '#short', '#' + SEED_TEXT.slice(1), '#' + SEED_TEXT + 'x', '#' + Buffer.alloc(31).toString('base64url')]) {
    const view = render(fragment, true, script, { pathname: '/i/abcde23456', globals: { fetch: async () => assert.fail('no request for a malformed link'), crypto: webcrypto } });
    await view.ready;
    assert.match(view.element('status').textContent, /malformed. Ask the person who invited you for a new link$/);
    assert.equal(view.element('copy').disabled, true);
  }
});

test('short link: retry reuses the scrubbed in-memory link and keeps verification gated', async () => {
  const publication = shortFixture(), good = respond(publication);
  let attempts = 0;
  const view = await renderShort(publication, { globals: { fetch: async (...args) => {
    attempts++;
    if (attempts === 1) throw new Error('offline');
    return good.fetch(...args);
  } } });
  assert.equal(view.element('copy').disabled, true);
  assert.equal(view.element('retry').hidden, false);
  assert.match(view.status, /Open the original invitation link again/);
  assert.equal(view.history.length, 1);
  assert.equal(view.history[0][2], '/i/abcde23456');
  assert.equal(view.element('invitation').value, '');

  view.element('retry').handlers.click();
  await view.context.faravanJoinReady;
  assert.equal(attempts, 2);
  assert.equal(view.element('retry').hidden, true);
  assert.equal(view.element('copy').disabled, false);
  assert.equal(view.element('open').href, 'faravan://join?link=' + encodeURIComponent(view.href));
  assert.equal(view.history.length, 1);
  await view.element('copy').handlers.click();
  assert.deepEqual(view.copied, [view.href]);
});

test('short link: a hanging lookup times out, and invite_used has its own remedy', async () => {
  const publication = shortFixture();
  const timedOut = await renderShort(publication, { globals: {
    setTimeout(callback, delay) { assert.equal(delay, 10000); callback(); return 1; },
    clearTimeout() {},
    fetch: (_url, options) => new Promise((resolve, reject) => {
      if (options.signal.aborted) reject(new Error('aborted'));
      else options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }),
  } });
  assert.match(timedOut.status, /Could not reach this server/);
  assert.match(timedOut.status, /Open the original invitation link again/);
  assert.equal(timedOut.element('retry').hidden, false);
  assert.equal(timedOut.element('copy').disabled, true);

  let expireLookup, timeoutMs, timerCleared = false;
  const hangingBody = render('#' + SEED_TEXT, true, script, { pathname: '/i/' + publication.code,
    globals: { crypto: webcrypto,
      setTimeout(callback, delay) { timeoutMs = delay; expireLookup = callback; return 3; },
      clearTimeout(id) { assert.equal(id, 3); timerCleared = true; },
      fetch: async (_url, options) => ({ status: 200, ok: true, text: () => new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('body aborted')), { once: true });
      }) }),
    } });
  const bodyResult = hangingBody.ready;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(timeoutMs, 10000);
  assert.equal(hangingBody.element('status').textContent, 'Checking this invitation…');
  expireLookup();
  await bodyResult;
  assert.equal(timerCleared, true);
  assert.match(hangingBody.element('status').textContent, /Open the original invitation link again/);
  assert.equal(hangingBody.element('retry').hidden, false);

  const used = await renderShort(publication, { answer: { status: 409, body: JSON.stringify({ code: 'invite_used' }) } });
  assert.equal(used.status, 'This invitation was already used. Ask for a new one.');
  assert.equal(used.element('retry').hidden, true);
  assert.equal(used.element('copy').disabled, true);
  const otherConflict = await renderShort(publication, { answer: { status: 409, body: JSON.stringify({ code: 'other' }) } });
  assert.match(otherConflict.status, /Could not reach this server/);
  assert.equal(otherConflict.element('retry').hidden, false);
});

test('short link: the LAN notice appears only for a verified lan_mode invitation', async () => {
  const lan = shortFixture();
  const key = p.privateKeyFromSeed(SEED), root = p.generateRootKeyPair().privateKey;
  const envelope = p.createInvite({ circle: randomUUID(), coordinator: 'http://10.23.1.2:4000', invite_id: randomUUID(), lan_mode: true,
    invite_public_key: p.exportPublicKey(key), created_at: lan.envelope.payload.created_at, expires_at: lan.envelope.payload.expires_at, display_name: 'Kitchen' }, root);
  const publication = { code: 'abcde23456', envelope, invite_binding: p.createInviteBinding(envelope, key) };
  const view = render('#' + SEED_TEXT, true, script, { pathname: '/i/abcde23456', origin: 'http://10.23.1.2:4000',
    globals: { fetch: respond(publication).fetch, crypto: webcrypto } });
  await view.ready;
  assert.equal(view.element('lan-notice').hidden, false);
  assert.equal((await renderShort(shortFixture())).element('lan-notice').hidden, true);
});

test('long links label the circle name unverified and make no request', async () => {
  const view = render(invitation('Weekend projects'), true, script, { globals: { fetch: async () => assert.fail('a long link needs no request') } });
  assert.equal(view.ready, undefined);
  assert.equal(view.element('heading').textContent, "You're invited to the Faravan circle Weekend projects (unverified).");
  assert.equal(view.element('open').href, 'faravan://join?link=' + encodeURIComponent(view.href));
});

test('invite roles are displayed only with the same verification status as the invite', async () => {
  for (const role of [undefined, 'borrow', 'lend', 'both']) {
    const publication = shortFixture({role, max_uses: 2}), view = await renderShort(publication);
    assert.equal(view.element('role').textContent, role ?? 'lend');
    assert.equal(view.element('role').hidden, false);
    const unavailable = await renderShort(publication, {globals: {crypto: undefined}});
    assert.equal(unavailable.element('role').hidden, true);
    const long = p.encodeInviteLink(publication.envelope, SEED);
    const preview = render(new URL(long).hash);
    assert.equal(preview.element('role').textContent, (role ?? 'lend') + ' (unverified).');
  }
  const forged = shortFixture({role: 'borrow'});
  forged.envelope.payload.role = 'lend';
  assert.equal((await renderShort(forged)).element('role').hidden, true);
});

// Deterministic page time: advancing the wall clock need not dispatch queued timers (a suspended tab).
function pageClock(now = Math.floor(Date.now() / 1000) * 1000) {
  const timers = new Map();
  let nextTimer = 0;
  return {
    timers,
    globals: {
      Date: class extends Date { static now() { return now; } },
      setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay, at: now + delay }); return id; },
      clearTimeout(id) { timers.delete(id); },
    },
    advance(ms) { now += ms; },
    fire() {
      for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.callback(); }
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const pageTick = () => new Promise(resolve => setImmediate(resolve));

for (const stage of ['fetch', 'body']) for (const abortSupport of ['missing', 'ignored']) {
  test('short link: deadline bounds hanging ' + stage + ' with AbortController ' + abortSupport, async () => {
    const clock = pageClock(), first = deferred(), publication = shortFixture();
    const net = respond(publication);
    let attempts = 0;
    const view = render('#' + SEED_TEXT, true, script, { pathname: '/i/' + publication.code, globals: {
      ...clock.globals, crypto: webcrypto,
      AbortController: abortSupport === 'missing' ? undefined : AbortController,
      fetch: (...args) => {
        if (++attempts > 1) return net.fetch(...args);
        return stage === 'fetch' ? first.promise : Promise.resolve({ status: 200, ok: true, text: () => first.promise });
      },
    } });
    let settled = false;
    view.ready.then(() => { settled = true; });
    await pageTick();
    clock.advance(10000); clock.fire();
    await pageTick();
    assert.equal(settled, true, 'the deadline settles independently of fetch/abort cooperation');
    await view.ready;
    assert.match(view.element('status').textContent, /Could not reach this server/);
    assert.equal(view.element('retry').hidden, false);
    assert.equal(view.element('copy').disabled, true);
    assert.equal(clock.timers.size, 0, 'the lookup deadline is cleaned up');

    view.element('retry').handlers.click();
    await view.context.faravanJoinReady;
    const heading = view.element('heading').textContent;
    assert.equal(heading, 'Tessa invited you to Critics.');
    assert.equal(view.element('copy').disabled, false);
    // A timed-out request must have no UI side effects, even after a successful retry.
    first.resolve(stage === 'fetch'
      ? { status: 410, ok: false, text: async () => '{}' }
      : JSON.stringify({ envelope: null, invite_binding: null }));
    await pageTick(); await pageTick();
    assert.equal(view.element('heading').textContent, heading);
    assert.equal(view.element('status').textContent, '');
    assert.equal(view.element('copy').disabled, false);
    assert.equal(view.element('retry').hidden, true);
  });
}

test('short link: a verified expired publication is expired, but an expired forgery stays untrusted', async () => {
  const real = shortFixture({ expires: new Date(Date.now() - 1000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  const expired = await renderShort(real);
  assert.equal(expired.status, 'This invitation has expired. Ask the person who invited you for a new link.');
  assert.notEqual(expired.heading, FAILED);
  assert.equal(expired.element('copy').disabled, true);
  assert.equal(expired.element('open').href, '#paste');
  assert.equal(expired.element('email').hidden, true);
  assert.equal(expired.element('retry').hidden, true);
  real.envelope.payload.owner_name = 'Forged owner';
  const forged = await renderShort(real);
  assert.equal(forged.heading, FAILED);
  assert.match(forged.status, /can’t be trusted/);
  assert.doesNotMatch(forged.heading + forged.status + forged.identity, /Forged owner|Critics/);
  assert.equal(forged.element('copy').disabled, true);
});

async function expiringView(kind, clock, { clipboardWorks = true, phone = false } = {}) {
  const expires = new Date(clock.globals.Date.now() + 1000).toISOString().replace('.000Z', 'Z');
  const publication = kind === 'short' ? shortFixture({ expires }) : null;
  const view = render(kind === 'short' ? '#' + SEED_TEXT : invitation('Near expiry', undefined, expires),
    clipboardWorks, script, {
      pathname: kind === 'short' ? '/i/' + publication.code : '/join',
      navigator: phone ? devices[0] : {},
      globals: { ...clock.globals, crypto: webcrypto, fetch: publication ? respond(publication).fetch : undefined },
    });
  await view.ready;
  assert.equal(view.element('copy').disabled, false);
  return view;
}

for (const kind of ['long', 'short']) {
  for (const action of ['copy', 'open', 'email']) {
    test(kind + ' link: ' + action + ' rechecks expiry before action even when timers are delayed', async () => {
      const clock = pageClock(), view = await expiringView(kind, clock, { phone: action === 'email' });
      clock.advance(1000); // Deliberately do not dispatch the expiry timer.
      let prevented = false;
      assert.equal(typeof view.element(action).handlers.click, 'function');
      await view.element(action).handlers.click({ preventDefault() { prevented = true; } });
      if (action !== 'copy') assert.equal(prevented, true, 'the app/mail handoff is prevented');
      assert.equal(view.copied.length, 0);
      assert.equal(view.element('copy').disabled, true);
      assert.equal(view.element('open').href, '#paste');
      assert.equal(view.element('email').hidden, true);
      assert.equal(view.element('email').href, undefined, 'no stale mailto capability remains');
      assert.match(view.element('status').textContent, /has expired/);
    });
  }

  test(kind + ' link: expiry timer disables actions and clears a visible manual-copy fallback', async () => {
    const clock = pageClock(), view = await expiringView(kind, clock, { clipboardWorks: false, phone: true });
    await view.element('copy').handlers.click();
    assert.equal(view.element('manual').hidden, false);
    assert.equal(view.element('invitation').value, view.href);
    clock.advance(1000); clock.fire();
    assert.match(view.element('status').textContent, /has expired/);
    assert.equal(view.element('copy').disabled, true);
    assert.equal(view.element('open').href, '#paste');
    assert.equal(view.element('email').hidden, true);
    assert.equal(view.element('email').href, undefined);
    assert.equal(view.element('manual').hidden, true);
    assert.equal(view.element('invitation').value, '');
    assert.equal(clock.timers.size, 0);
  });

  for (const outcome of ['resolve', 'reject']) {
    test(kind + ' link: a late clipboard ' + outcome + ' cannot overwrite expiry or reveal manual copy', async () => {
      const clock = pageClock(), view = await expiringView(kind, clock);
      const copying = deferred();
      view.context.navigator.clipboard.writeText = () => copying.promise;
      const action = view.element('copy').handlers.click();
      clock.advance(1000); clock.fire();
      copying[outcome](outcome === 'reject' ? new Error('blocked') : undefined);
      await action;
      assert.match(view.element('status').textContent, /has expired/);
      assert.equal(view.element('manual').hidden, true);
      assert.equal(view.element('invitation').value, '');
      assert.equal(view.element('copy').disabled, true);
    });
  }
}

test('long link: expiry timers are capped and rearmed without early expiration', () => {
  const clock = pageClock(), view = render(invitation(), true, script, { globals: clock.globals });
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].delay, 2147483647);
  clock.advance(2147483647); clock.fire();
  assert.equal(view.element('copy').disabled, false);
  assert.equal(clock.timers.size, 1);
  assert.equal([...clock.timers.values()][0].delay, 2147483647);
});

test('expired links hide stale installation and open instructions',async()=>{
 const expired=await renderShort(shortFixture({expires:new Date(Date.now()-1000).toISOString().replace(/\.\d+Z$/,'Z')}));
 for(const id of ['open','paste','get','install','download-note'])assert.equal(expired.element(id).hidden,true,id);
});
