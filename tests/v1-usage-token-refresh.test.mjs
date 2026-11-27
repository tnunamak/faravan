import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, readdir, rm} from 'node:fs/promises';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {createUsageAccountStore, credentialLockMutation} from '../lib/v1/usage-account-store.mjs';
import {acquireCredentialMutation} from '../lib/sandbox-credentials.mjs';
import {createUsageHostReader} from '../lib/v1/usage-host-reader.mjs';
import {createUsageTokenRefresher} from '../lib/v1/usage-token-refresh.mjs';
import {PROVIDER_RECORDS} from '../lib/v1/usage-provider-records.mjs';
import {createProviderSource, publishProviderGeneration, currentProviderGeneration} from '../lib/credential-generations.mjs';
import {createLendingProbe} from '../lib/v1/lending-probe.mjs';
import {probeFailureCopy} from '../lib/v1/lending-status-copy.mjs';
import {stat} from 'node:fs/promises';

// Throwaway home, synthetic tokens, and a fake token endpoint. No provider is contacted.
const NOW = Date.UTC(2026, 10, 11, 12);
const soon = NOW + 60_000, later = NOW + 8 * 3600e3;
const claudeValue = (token, refresh, expiresAt) => ({claudeAiOauth: {accessToken: token, refreshToken: refresh, expiresAt, scopes: ['user:inference'], subscriptionType: 'max'}, keep: 'me'});
const jwt = exp => 'h.' + Buffer.from(JSON.stringify({exp})).toString('base64url') + '.s';
const codexValue = (access, refresh) => ({auth_mode: 'chatgpt', tokens: {access_token: access, id_token: 'synthetic-id', refresh_token: refresh, account_id: 'acct-1'}, last_refresh: 'old'});
async function freshHome(t) {
  await mkdir(join(homedir(), '.tmp'), {recursive: true});
  const home = await mkdtemp(join(homedir(), '.tmp', 'usage-refresh-'));
  t.after(() => rm(home, {recursive: true, force: true}));
  return home;
}
async function signIn(home, provider, value) {
  const source = await createProviderSource(home, provider);
  await writeFile(join(source.directory, provider === 'claude' ? '.credentials.json' : 'auth.json'), JSON.stringify(value), {mode: 0o600});
  return publishProviderGeneration(home, source);
}
const usage = {five_hour: {utilization: 1, resets_at: new Date(NOW + 3600e3).toISOString()}, seven_day: {utilization: 1, resets_at: new Date(NOW + 86400e3).toISOString()}, extra_usage: {is_enabled: false}};
const codexUsage = {plan_type: 'plus', spend_control: {reached: false}, credits: {has_credits: false}, account_id: 'acct-1', email: 'owner@example.test',
  rate_limit: {allowed: true, limit_reached: false, primary_window: {used_percent: 1, limit_window_seconds: 18000, reset_at: Math.floor(NOW / 1000) + 4000}}};

// A fake provider: token endpoints (POST) and usage endpoints (GET). `token` decides the token reply.
function fakeNet({token, profile = {account: {uuid: 'uuid-a'}, organization: {uuid: 'org-a'}}} = {}) {
  const log = [];
  const fetchImpl = async (url, options) => {
    const u = new URL(url);
    const entry = {method: options.method, host: u.hostname, path: u.pathname, redirect: options.redirect, auth: options.headers?.Authorization, body: options.body ? JSON.parse(options.body) : null};
    log.push(entry);
    let reply;
    if (options.method === 'POST') reply = token(entry, log.filter(e => e.method === 'POST').length);
    else if (u.pathname === '/api/oauth/usage') reply = {status: 200, body: usage};
    else if (u.pathname === '/api/oauth/profile') reply = {status: 200, body: typeof profile === 'function' ? profile(entry) : profile};
    else if (u.pathname === '/backend-api/wham/usage') reply = {status: 200, body: codexUsage};
    else reply = {status: 404, body: {}};
    return {status: reply.status, headers: {get: name => reply.headers?.[name] ?? null}, json: async () => reply.body};
  };
  return {log, fetchImpl, posts: () => log.filter(e => e.method === 'POST')};
}
const granted = (access = 'synthetic-new-access', refresh = 'synthetic-new-refresh') => () => ({status: 200, body: {access_token: access, refresh_token: refresh, expires_in: 28800}});
function build(home, net, extra = {}) {
  const store = extra.store ?? createUsageAccountStore({home});
  const reader = createUsageHostReader({store, fetchImpl: net.fetchImpl, now: () => NOW});
  const refresher = createUsageTokenRefresher({store, reader, fetchImpl: net.fetchImpl, now: extra.now ?? (() => NOW), sleep: async () => {}, backoffMs: extra.backoffMs ?? 0});
  return {store, reader, refresher};
}

test('the records carry the CLI token endpoints and client ids', () => {
  assert.deepEqual(PROVIDER_RECORDS.claude.refresh, {url: 'https://platform.claude.com/v1/oauth/token', clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e', hosts: ['platform.claude.com']});
  assert.deepEqual(PROVIDER_RECORDS.codex.refresh, {url: 'https://auth.openai.com/oauth/token', clientId: 'app_EMoamEEZ73f0CkXaXp7hrann', hosts: ['auth.openai.com']});
});

test('a Claude token near expiry is refreshed: one request, one verified save, the rotated pair kept and the rest of the file preserved', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  const first = await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const {store, refresher} = build(home, net);
  const result = await refresher.refresh('claude');
  assert.deepEqual([result.ok, result.refreshed], [true, true]);
  const body = net.posts()[0];
  assert.deepEqual(body.body, {grant_type: 'refresh_token', refresh_token: 'synthetic-old-refresh', client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e'});
  assert.deepEqual([body.host, body.path, body.redirect], ['platform.claude.com', '/v1/oauth/token', 'manual']);
  assert.equal(net.posts().length, 1);
  const cred = await store.credential('claude');
  assert.deepEqual([cred.bearer, cred.refresh, cred.expiresAt], ['synthetic-new-access', 'synthetic-new-refresh', NOW + 28800_000]);
  assert.notEqual(cred.generation, first.id);
  const current = await currentProviderGeneration(home, 'claude');
  const file = JSON.parse(await readFile(join(current.directory, current.file), 'utf8'));
  assert.equal(file.keep, 'me');
  assert.deepEqual(file.claudeAiOauth.scopes, ['user:inference']);
  assert.equal((await store.successor('claude')).generation, cred.generation);
  assert.deepEqual((await readdir(home)).filter(n => n.startsWith('usage-refresh-staged')), [], 'the staged pair is gone after the save');
  const verification = net.log.filter(e => e.auth === 'Bearer synthetic-new-access');
  assert.ok(verification.length >= 1, 'the new token was checked with a host read before it was saved');
  assert.ok(net.log.every(e => e.redirect === 'manual'));
  assert.equal(refresher.isDue(cred), false);
});

test('a token with plenty of life is not refreshed', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  await signIn(home, 'claude', claudeValue('synthetic-a', 'synthetic-r', later));
  const {refresher} = build(home, net);
  assert.deepEqual(await refresher.refresh('claude'), {ok: true, refreshed: false, generation: (await currentProviderGeneration(home, 'claude')).id});
  assert.equal(net.log.length, 0);
});

test('a Codex token near expiry is refreshed, with its expiry read from the token itself', async t => {
  const home = await freshHome(t), net = fakeNet({token: () => ({status: 200, body: {access_token: jwt(Math.floor(later / 1000)), refresh_token: 'synthetic-new-refresh', id_token: 'synthetic-new-id'}})});
  await signIn(home, 'codex', codexValue(jwt(Math.floor(soon / 1000)), 'synthetic-old-refresh'));
  const {store, refresher} = build(home, net);
  assert.equal(refresher.isDue(await store.credential('codex')), true);
  const result = await refresher.refresh('codex');
  assert.equal(result.refreshed, true);
  const post = net.posts()[0];
  assert.deepEqual([post.host, post.body.client_id, post.body.refresh_token], ['auth.openai.com', 'app_EMoamEEZ73f0CkXaXp7hrann', 'synthetic-old-refresh']);
  const current = await currentProviderGeneration(home, 'codex');
  const file = JSON.parse(await readFile(join(current.directory, current.file), 'utf8'));
  assert.deepEqual([file.tokens.refresh_token, file.tokens.id_token, file.tokens.account_id, file.auth_mode], ['synthetic-new-refresh', 'synthetic-new-id', 'acct-1', 'chatgpt']);
  assert.notEqual(file.last_refresh, 'old');
});

test('a staged Codex refresh publishes when usage omits the account ID', async t => {
  const home = await freshHome(t);
  const prior = await signIn(home, 'codex', codexValue(jwt(Math.floor(soon / 1000)), 'old'));
  const net = fakeNet({token: () => { throw new Error('an existing stage must not exchange again'); }});
  const fetchUsage = net.fetchImpl;
  net.fetchImpl = async (...args) => {
    const reply = await fetchUsage(...args);
    return {...reply, json: async () => ({...codexUsage, account_id: undefined, email: 'owner@example.test'})};
  };
  const {store, refresher} = build(home, net);
  const {createHash} = await import('node:crypto');
  const identity = createHash('sha256').update('acct-1').digest('hex').slice(0, 16);
  assert.equal(await store.bindIdentity('codex', prior.id, identity), true);
  const claims = {
    exp: Math.floor(later / 1000),
    'https://api.openai.com/auth': {chatgpt_account_id: 'acct-1'},
    'https://api.openai.com/profile': {email: 'owner@example.test'},
  };
  const bearer = 'h.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.s';
  await store.stageRefresh('codex', {priorGeneration: prior.id, value: codexValue(bearer, 'new')});
  const result = await refresher.refresh('codex');
  assert.equal(result.refreshed, true, result.reason);
  assert.notEqual((await currentProviderGeneration(home, 'codex')).id, prior.id);
  assert.equal(await store.stagedRefresh('codex'), null);
  assert.equal(net.posts().length, 0);
});

test('a newer sign-in wins while a staged refresh is being verified', {timeout: 5000}, async t => {
  const home = await freshHome(t);
  const prior = await signIn(home, 'codex', codexValue(jwt(Math.floor(soon / 1000)), 'synthetic-prior'));
  let reachedVerification, resumeVerification;
  const verifying = new Promise(resolve => { reachedVerification = resolve; });
  const resume = new Promise(resolve => { resumeVerification = resolve; });
  const net = fakeNet({token: () => { throw new Error('staged refresh must not exchange'); }});
  const fetchUsage = net.fetchImpl;
  net.fetchImpl = async (...args) => {
    const reply = await fetchUsage(...args);
    if (args[1].method === 'GET') {
      reachedVerification();
      await resume;
    }
    return reply;
  };
  const {store, refresher} = build(home, net);
  const {createHash} = await import('node:crypto');
  assert.equal(await store.bindIdentity('codex', prior.id, createHash('sha256').update('acct-1').digest('hex').slice(0, 16)), true);
  await store.stageRefresh('codex', {priorGeneration: prior.id, value: codexValue(jwt(Math.floor(later / 1000)), 'synthetic-staged')});
  const task = refresher.refresh('codex');
  let newer;
  try {
    await Promise.race([verifying, task.then(() => { throw new Error('refresh settled before verification'); })]);
    newer = await signIn(home, 'codex', codexValue(jwt(Math.floor((later + 1000) / 1000)), 'synthetic-newer-sign-in'));
  } finally {
    resumeVerification();
  }
  const result = await task;
  assert.deepEqual([result.ok, result.refreshed], [true, false]);
  assert.equal((await store.credential('codex')).generation, newer.id);
  assert.equal((await store.value('codex')).value.tokens.refresh_token, 'synthetic-newer-sign-in');
  assert.equal(await store.stagedRefresh('codex'), null);
  assert.equal(net.posts().length, 0);
});

test('invalid_grant makes only that account unknown, keeps the old sign-in on disk, and is not retried', async t => {
  const home = await freshHome(t), net = fakeNet({token: () => ({status: 400, body: {error: 'invalid_grant', error_description: 'synthetic-secret-text'}})});
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  await signIn(home, 'codex', codexValue(jwt(Math.floor(later / 1000)), 'synthetic-codex-refresh'));
  const {store, refresher} = build(home, net);
  const result = await refresher.refresh('claude');
  assert.deepEqual([result.ok, result.reason, result.account_state], [false, 'invalid_grant', 'unknown']);
  assert.ok(!JSON.stringify(result).includes('synthetic'), 'no token or reply text in the result');
  assert.equal((await store.credential('claude')).bearer, 'synthetic-old-access');
  assert.equal(await refresher.rejection('claude'), 'invalid_grant');
  await refresher.refresh('claude');
  assert.equal(net.posts().length, 1, 'a rejected grant is not sent again until the sign-in changes');
  // The other provider reads on.
  const readerWith = createUsageHostReader({store, fetchImpl: net.fetchImpl, now: () => NOW, refresher});
  await assert.rejects(readerWith.read({provider: 'claude', accountKey: 'claude'}), e => e.probe_failure === 'probe_unavailable' && e.code === 'refresh_rejected');
  assert.equal((await readerWith.read({provider: 'codex', accountKey: 'codex'})).host_read, true);
  assert.equal(await refresher.rejection('codex'), null);
  // A new sign-in clears the memo.
  await signIn(home, 'claude', claudeValue('synthetic-fresh-access', 'synthetic-fresh-refresh', later));
  assert.equal(await refresher.rejection('claude'), null);
});

test('two refreshes at once make one request and one save', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  const first = await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const {refresher} = build(home, net);
  const [a, b] = await Promise.all([refresher.refresh('claude'), refresher.refresh('claude', {ifGeneration: first.id})]);
  assert.deepEqual([a.refreshed, b.refreshed], [true, true]);
  assert.equal(net.posts().length, 1);
  assert.equal(refresher.requests().saves, 1);
  // A caller that read the old generation and arrives after the save does nothing.
  const late = await refresher.refresh('claude', {force: true, ifGeneration: first.id});
  assert.equal(late.refreshed, false);
  assert.equal(net.posts().length, 1);
});

test('a crash between the reply and the save loses nothing: the next refresh finishes from the staged pair with no new request', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  const first = await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const real = createUsageAccountStore({home});
  const crashing = {...real, rotate: async () => { throw new Error('simulated crash before the save'); }};
  const run1 = build(home, net, {store: crashing});
  await assert.rejects(run1.refresher.refresh('claude'), /simulated crash/);
  assert.equal(net.posts().length, 1);
  assert.equal((await real.credential('claude')).generation, first.id, 'the last good entry is still the current one');
  assert.equal((await real.credential('claude')).bearer, 'synthetic-old-access');
  const staged = await real.stagedRefresh('claude');
  assert.equal(staged.value.claudeAiOauth.refreshToken, 'synthetic-new-refresh', 'the one-use refresh token was kept');
  // A new process: no memory of the first.
  const run2 = build(home, net);
  const result = await run2.refresher.refresh('claude');
  assert.deepEqual([result.ok, result.refreshed], [true, true]);
  assert.equal(net.posts().length, 1, 'no second token request');
  assert.equal((await run2.store.credential('claude')).bearer, 'synthetic-new-access');
  assert.equal(await run2.store.stagedRefresh('claude'), null);
});

test('a refreshed token that names another account is refused and nothing is saved', async t => {
  const home = await freshHome(t);
  let who = 'uuid-a';
  const net = fakeNet({token: granted(), profile: entry => ({account: {uuid: entry.auth === 'Bearer synthetic-new-access' ? 'uuid-other' : who}, organization: {uuid: 'org-a'}})});
  const first = await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const {store, reader, refresher} = build(home, net);
  await reader.read({provider: 'claude', accountKey: 'claude'});   // binds the account's identity for this generation
  const result = await refresher.refresh('claude');
  assert.deepEqual([result.ok, result.reason, result.account_state], [false, 'identity_changed', 'unknown']);
  assert.equal((await store.credential('claude')).generation, first.id);
  assert.equal(await store.stagedRefresh('claude'), null);
});

test('a redirect, a server error or a 429 never moves the credential; a 429 defers the next refresh', async t => {
  const home = await freshHome(t);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  for (const status of [302, 500]) {
    const net = fakeNet({token: () => ({status, headers: {location: 'https://evil.example/'}, body: {}})});
    const {store, refresher} = build(home, net);
    const result = await refresher.refresh('claude');
    assert.deepEqual([result.ok, result.account_state], [false, 'retry']);
    assert.equal(net.posts().length, 1);
    assert.equal((await store.credential('claude')).bearer, 'synthetic-old-access');
  }
  const net = fakeNet({token: () => ({status: 429, headers: {'retry-after': '1'}, body: {}})});
  const {refresher} = build(home, net);
  assert.equal((await refresher.refresh('claude')).account_state, 'retry');
  assert.equal(net.posts().length, 1, 'a throttled exchange does not retry inline');
});

// A usage 401 forces one refresh for that account and one re-read. `refuses` names the bearers the fake usage endpoint refuses.
function refusing(net, refuses) {
  const inner = net.fetchImpl, usageReads = [];
  net.fetchImpl = async (url, options) => {
    if (options.method === 'GET' && new URL(url).pathname === '/api/oauth/usage') {
      usageReads.push(options.headers.Authorization);
      const refused = typeof refuses === 'function' ? refuses(usageReads.length) : refuses.includes(options.headers.Authorization.replace('Bearer ', ''));
      if (refused) return {status: 401, headers: {get: () => null}, json: async () => ({})};
    }
    return inner(url, options);
  };
  return usageReads;
}
// The account's identity is bound by its first successful read, before anything is refused.
async function bindByFirstRead(home, provider = 'claude') {
  const plain = fakeNet({token: granted()}), store = createUsageAccountStore({home});
  await createUsageHostReader({store, fetchImpl: plain.fetchImpl, now: () => NOW}).read({provider, accountKey: provider});
  assert.ok(await store.identity(provider), 'identity bound on disk');
}
function readerWithRefresh(home, net) {
  const store = createUsageAccountStore({home});
  let reader;
  const refresher = createUsageTokenRefresher({store, reader: {verify: args => reader.verify(args)}, fetchImpl: net.fetchImpl, now: () => NOW, sleep: async () => {}, backoffMs: 0});
  reader = createUsageHostReader({store, fetchImpl: net.fetchImpl, now: () => NOW, refresher});
  return {store, reader, refresher};
}
const status = result => JSON.parse(result.stdout).status;

test('a 401 on a usage read forces one refresh and one re-read with the new sign-in', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  const reads = refusing(net, ['synthetic-old-access']);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', later));
  await bindByFirstRead(home);
  const {reader} = readerWithRefresh(home, net);
  const result = await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(status(result), 200);
  assert.equal(net.posts().length, 1, 'one refresh request');
  // The middle read is the refresh's own check of the new token before it is saved; the last is the one re-read.
  assert.deepEqual(reads, ['Bearer synthetic-old-access', 'Bearer synthetic-new-access', 'Bearer synthetic-new-access']);
});

test('a 401 whose refresh is refused makes the account unknown: no re-read, no second refresh, no loop', async t => {
  const home = await freshHome(t), net = fakeNet({token: () => ({status: 400, body: {error: 'invalid_grant'}})});
  const reads = refusing(net, ['synthetic-old-access']);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', later));
  await bindByFirstRead(home);
  const {reader} = readerWithRefresh(home, net);
  assert.equal(status(await reader.read({provider: 'claude', accountKey: 'claude'})), 401);
  assert.equal(status(await reader.read({provider: 'claude', accountKey: 'claude'})), 401);
  assert.equal(net.posts().length, 1, 'a refused grant is not sent again until the sign-in changes');
  assert.equal(reads.length, 2, 'one usage read per call and no re-read');
});

test('a second 401 after a good refresh is the answer: one refresh and one re-read only', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  // The refresh's own check of the new token passes (read 2); the re-read (read 3) is refused again.
  const reads = refusing(net, n => n !== 2);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', later));
  await bindByFirstRead(home);
  const {reader} = readerWithRefresh(home, net);
  assert.equal(status(await reader.read({provider: 'claude', accountKey: 'claude'})), 401);
  assert.equal(net.posts().length, 1);
  assert.equal(reads.length, 3, 'the old token, the refresh check of the new one, and one re-read');
});

test('two concurrent reads that both get a 401 make one refresh request', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  refusing(net, ['synthetic-old-access']);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', later));
  await bindByFirstRead(home);
  const {reader} = readerWithRefresh(home, net);
  const [a, b] = await Promise.all([reader.read({provider: 'claude', accountKey: 'claude'}), reader.read({provider: 'claude', accountKey: 'claude'})]);
  assert.deepEqual([status(a), status(b)], [200, 200]);
  assert.equal(net.posts().length, 1, 'one refresh request, not two');
});

test('a 401 refreshes only the account that was refused', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  const reads = refusing(net, ['synthetic-old-access']);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', later));
  await bindByFirstRead(home);
  await signIn(home, 'codex', codexValue('synthetic-codex-access', 'synthetic-codex-refresh'));
  const {reader} = readerWithRefresh(home, net);
  await reader.read({provider: 'claude', accountKey: 'claude'});
  const before = net.posts().length;
  assert.equal((await reader.read({provider: 'codex', accountKey: 'codex'})).host_read, true);
  assert.equal(net.posts().length, before, 'the other account made no refresh');
  assert.ok(reads.length >= 1);
});

test('a caller that aborts after the provider rotated the token does not lose the new pair', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  let release; const gate = new Promise(resolve => { release = resolve; });
  let sent; const seen = new Promise(resolve => { sent = resolve; });
  const inner = net.fetchImpl;
  net.fetchImpl = async (url, options) => {
    if (options.method === 'POST') { sent(); await gate; }
    return inner(url, options);
  };
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const {store, refresher} = build(home, net);
  const controller = new AbortController();
  const first = refresher.refresh('claude', {signal: controller.signal});
  await seen;
  controller.abort();
  await assert.rejects(first, /abort|Abort/i, 'the aborted caller stops waiting');
  release();
  const second = await refresher.refresh('claude');
  assert.deepEqual([second.ok, second.refreshed], [true, true], 'the flight finished on its own');
  assert.equal(net.posts().length, 1);
  assert.equal((await store.credential('claude')).bearer, 'synthetic-new-access');
});

test('a 200 is staged as received before any lookup: a failed lookup keeps the old entry and the reply, and the next call saves it', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const real = createUsageAccountStore({home});
  let breakLookup = true;
  const store = {...real, value: async key => { if (breakLookup) throw new Error('lookup failed'); return real.value(key); }};
  const {refresher} = build(home, net, {store});
  const result = await refresher.refresh('claude');
  assert.deepEqual([result.ok, result.account_state], [false, 'retry']);
  assert.equal((await real.credential('claude')).bearer, 'synthetic-old-access', 'the old entry is kept');
  assert.equal((await real.stagedRefresh('claude')).raw.refresh_token, 'synthetic-new-refresh', 'the reply is staged as received');
  breakLookup = false;
  const again = await refresher.refresh('claude');
  assert.deepEqual([again.ok, again.refreshed], [true, true]);
  assert.equal(net.posts().length, 1, 'no second request: the one-use token was not spent twice');
  assert.equal((await real.credential('claude')).refresh, 'synthetic-new-refresh');
});

test('a malformed 200 is staged, marks the account retry and never drops the reply', async t => {
  const home = await freshHome(t), net = fakeNet({token: () => ({status: 200, body: {refresh_token: 'synthetic-only-refresh'}})});
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const {store, refresher} = build(home, net);
  const result = await refresher.refresh('claude');
  assert.deepEqual([result.ok, result.reason, result.account_state], [false, 'refresh_reply_invalid', 'retry']);
  assert.equal((await store.credential('claude')).bearer, 'synthetic-old-access');
  assert.equal((await store.stagedRefresh('claude')).raw.refresh_token, 'synthetic-only-refresh');
});

test('a reply that cannot be staged is held in memory and used by the next call, with no second request', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const real = createUsageAccountStore({home});
  let fail = true;
  const store = {...real, stageRefresh: async (...args) => { if (fail) throw new Error('disk full'); return real.stageRefresh(...args); }};
  const {refresher} = build(home, net, {store});
  assert.equal((await refresher.refresh('claude')).account_state, 'retry');
  fail = false;
  const again = await refresher.refresh('claude');
  assert.deepEqual([again.ok, again.refreshed], [true, true]);
  assert.equal(net.posts().length, 1);
});

// ---- identity binding -------------------------------------------------------------------------------------------------
const profileFor = uuid => ({account: {uuid}, organization: {uuid: 'org-a'}});

test('after a restart the stored identity still guards a refresh: another account\'s token is refused and nothing is saved', async t => {
  const home = await freshHome(t);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  await bindByFirstRead(home);   // first process: the first successful read binds uuid-a on disk
  let who = 'uuid-b';            // second process: the new token belongs to someone else
  const net = fakeNet({token: granted(), profile: () => profileFor(who)});
  const {store, refresher} = build(home, net);
  const result = await refresher.refresh('claude');
  assert.deepEqual([result.ok, result.reason, result.account_state], [false, 'identity_changed', 'unknown']);
  assert.equal((await store.credential('claude')).bearer, 'synthetic-old-access', 'nothing was saved');
});

test('Codex caches and persists its identity too, and a refresh to another account is refused', async t => {
  const home = await freshHome(t);
  await signIn(home, 'codex', codexValue('h.' + Buffer.from(JSON.stringify({exp: Math.floor(soon / 1000)})).toString('base64url') + '.s', 'synthetic-codex-refresh'));
  const first = fakeNet({token: granted()}), store1 = createUsageAccountStore({home});
  const reader1 = createUsageHostReader({store: store1, fetchImpl: first.fetchImpl, now: () => NOW});
  await reader1.read({provider: 'codex', accountKey: 'codex'});
  assert.ok(await store1.identity('codex'), 'Codex identity is stored on its first read');
  // A restarted process: the replacement token reads as a different account_id.
  const net = fakeNet({token: granted()});
  const inner = net.fetchImpl;
  net.fetchImpl = async (url, options) => {
    const reply = await inner(url, options);
    if (new URL(url).pathname === '/backend-api/wham/usage') return {...reply, json: async () => ({...codexUsage, account_id: 'acct-other'})};
    return reply;
  };
  const {store, refresher} = build(home, net);
  const result = await refresher.refresh('codex');
  assert.deepEqual([result.ok, result.reason], [false, 'identity_changed']);
  assert.equal(net.posts().length, 1);
  assert.ok((await store.credential('codex')).refresh === 'synthetic-codex-refresh', 'the old pair is kept');
});

test('with no stored identity a refresh first binds it with the current token; if that fails nothing is sent or saved', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  refusing(net, ['synthetic-old-access']);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  const {store, refresher} = build(home, net);
  const result = await refresher.refresh('claude');
  assert.deepEqual([result.ok, result.reason, result.account_state], [false, 'identity_unbound', 'retry']);
  assert.equal(net.posts().length, 0, 'no token request was made');
  assert.equal(await store.identity('claude'), null);
  // A good current token binds, then the refresh goes ahead.
  const ok = fakeNet({token: granted()}), again = build(home, ok);
  const done = await again.refresher.refresh('claude');
  assert.deepEqual([done.ok, done.refreshed], [true, true]);
  assert.ok(await again.store.identity('claude'), 'the identity carries to the new generation');
});

// ---- backoff, sign-in copy, file modes, cross-process lock -------------------------------------------------------------------
test('after a retry outcome the account waits: no request and no sleep in the next reads, then it tries again', async t => {
  const home = await freshHome(t);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', NOW + 540_000));
  await bindByFirstRead(home);
  let clock = NOW, slept = 0;
  const net = fakeNet({token: () => ({status: 503, body: {}})});
  const store = createUsageAccountStore({home});
  let reader;
  const refresher = createUsageTokenRefresher({store, reader: {verify: a => reader.verify(a)}, fetchImpl: net.fetchImpl, now: () => clock, sleep: async () => { slept++; }, backoffMs: 60_000});
  reader = createUsageHostReader({store, fetchImpl: net.fetchImpl, now: () => clock, refresher});
  for (let i = 0; i < 5; i++) assert.equal((await reader.read({provider: 'claude', accountKey: 'claude'})).host_read, true, 'the old token is still read');
  assert.equal(net.posts().length, 1, 'one request, then the wait');
  assert.equal(slept, 0);
  clock += 61_000;
  await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(net.posts().length, 2, 'it tries again once the wait is over');
  clock += 61_000;
  await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(net.posts().length, 2, 'the wait doubled');
});

test('a refused grant reaches the owner as "Sign in again to <label>" through the reader and the probe', async t => {
  const home = await freshHome(t);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  await bindByFirstRead(home);
  const net = fakeNet({token: () => ({status: 400, body: {error: 'invalid_grant'}})});
  const {reader} = readerWithRefresh(home, net);
  const probe = createLendingProbe({runGuest: args => reader.read(args), now: () => NOW});
  const result = await probe.probe('claude');
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'auth');
  assert.match(probeFailureCopy({outcome: 'failed', reason: result.reason}, {accountLabel: 'A personal'}).action, /^Sign in again to A personal\.$/);
  await probe.close();
});

test('a rejected Codex renewal asks the owner to sign in again', () => {
  assert.equal(probeFailureCopy({outcome: 'failed', reason: 'auth'}, {provider: 'codex'}).line,
    'Codex sign-in expired: sign in again');
});

test('the store makes its directory owner-only, writes 0600, and leaves no temp file when the rename fails', {skip: process.platform === 'win32'}, async t => {
  const base = await freshHome(t), home = join(base, 'nested', 'store');
  const store = createUsageAccountStore({home, withMutation: async run => run()});
  await store.stageRefresh('claude', {priorGeneration: 'g1', raw: {access_token: 'synthetic-x'}});
  assert.equal((await stat(home)).mode & 0o777, 0o700);
  assert.equal((await stat(join(home, 'usage-refresh-staged-claude.json'))).mode & 0o777, 0o600);
  // The target is a directory, so the rename fails.
  await mkdir(join(home, 'usage-refresh-staged-codex.json'));
  await assert.rejects(store.stageRefresh('codex', {priorGeneration: 'g1', raw: {access_token: 'synthetic-y'}}));
  assert.deepEqual((await readdir(home)).filter(name => name.endsWith('.tmp')), [], 'the temp file is removed');
});

test('two processes sharing one home refresh one account at a time: a held refresh lock makes the second call wait, not send', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  await bindByFirstRead(home);
  const {store, refresher} = build(home, net);
  // Another process holds the cross-process refresh lock (a file lock under the shared home).
  const release = await store.lockRefresh('claude');
  const blocked = await refresher.refresh('claude');
  assert.deepEqual([blocked.ok, blocked.reason, blocked.account_state], [false, 'refresh_in_progress', 'retry']);
  assert.equal(net.posts().length, 0);
  release();
  assert.equal((await refresher.refresh('claude')).refreshed, true);
});

test('a busy credential lock reaches the caller as retry-later, not as a quiet refresh failure', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', soon));
  await bindByFirstRead(home);
  const store = createUsageAccountStore({home, withMutation: credentialLockMutation(home, {leaseWaitMs: 0})});
  const {reader, refresher} = build(home, net, {store});
  const refreshingReader = createUsageHostReader({store, fetchImpl: net.fetchImpl, now: () => NOW, refresher});
  const release = await acquireCredentialMutation(home, {isolatedSources: true, concurrentSources: true});
  const result = await refresher.refresh('claude');
  assert.deepEqual([result.ok, result.reason, result.account_state], [false, 'credential_locked', 'retry']);
  await assert.rejects(refreshingReader.read({provider: 'claude', accountKey: 'claude'}), e => e.probe_failure === 'probe_unavailable' && e.code === 'retry_later');
  assert.equal((await store.credential('claude')).bearer, 'synthetic-old-access', 'nothing was saved');
  release();
  assert.ok(reader);
});

// ---- forced-401 refresh edge cases -------------------------------------------------------------------------------------------
test('a 401 whose refresh finds the refresh lock busy reads retry-later: no re-read, no request, no auth claim', async t => {
  const home = await freshHome(t), net = fakeNet({token: granted()});
  const reads = refusing(net, ['synthetic-old-access']);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', later));
  await bindByFirstRead(home);
  const {store, reader} = readerWithRefresh(home, net);
  const release = await store.lockRefresh('claude');
  await assert.rejects(reader.read({provider: 'claude', accountKey: 'claude'}), error => error.code === 'retry_later' && error.probe_failure === 'probe_unavailable');
  assert.equal(net.posts().length, 0, 'no token request');
  assert.deepEqual(reads, ['Bearer synthetic-old-access'], 'the refused read is the only usage read');
  release();
  assert.equal(status(await reader.read({provider: 'claude', accountKey: 'claude'})), 200, 'it reads again once the lock is free');
});

test('the forced re-read passes the same expiry guard as a first read: an already-expired replacement is not sent', async t => {
  const home = await freshHome(t), net = fakeNet({token: () => ({status: 200, body: {access_token: 'synthetic-stale-access', refresh_token: 'synthetic-new-refresh', expires_in: 1}})});
  const reads = refusing(net, ['synthetic-old-access']);
  await signIn(home, 'claude', claudeValue('synthetic-old-access', 'synthetic-old-refresh', later));
  await bindByFirstRead(home);
  // The refresher's clock is an hour behind the reader's, so the replacement it dates one second out is already expired to the reader.
  const store = createUsageAccountStore({home});
  let reader;
  const refresher = createUsageTokenRefresher({store, reader: {verify: args => reader.verify(args)}, fetchImpl: net.fetchImpl, now: () => NOW - 3600e3, sleep: async () => {}, backoffMs: 0});
  reader = createUsageHostReader({store, fetchImpl: net.fetchImpl, now: () => NOW, refresher});
  // The refused reply names the replaced generation, so this read is discarded; the expired replacement is never sent for it.
  await assert.rejects(reader.read({provider: 'claude', accountKey: 'claude'}), error => error.probe_failure === 'cancelled');
  assert.equal(reads.filter(r => r === 'Bearer synthetic-stale-access').length, 1, 'only the refresh check used the replacement');
  // The next read meets the guard at the front door (its own due refresh gives another expired replacement, also not sent).
  await assert.rejects(reader.read({provider: 'claude', accountKey: 'claude'}), error => error.code === 'credential_expired');
});
