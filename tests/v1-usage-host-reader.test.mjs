import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createUsageHostReader} from '../lib/v1/usage-host-reader.mjs';
import {PROVIDER_RECORDS} from '../lib/v1/usage-provider-records.mjs';
import {parseProbeOutput, PROBE_REQUESTS} from '../lib/v1/lending-probe.mjs';

const NOW = Date.UTC(2026, 10, 11, 12);
const iso = hours => new Date(NOW + hours * 3600e3).toISOString();
const claudeUsage = {five_hour: {utilization: 40, resets_at: iso(1.25)}, seven_day: {utilization: 20, resets_at: iso(42)},
  extra_usage: {is_enabled: false, monthly_limit: 'not kept'}, email: 'must-not-pass'};
const codexUsage = {plan_type: 'plus', spend_control: {reached: false}, credits: {has_credits: false}, account_id: 'acct-1', email: 'a@example.test', rate_limit: {allowed: true, limit_reached: false,
  primary_window: {used_percent: 10, limit_window_seconds: 18000, reset_at: Math.floor(NOW / 1000) + 4000, extra: 1},
  secondary_window: {used_percent: 5, limit_window_seconds: 604800, reset_at: Math.floor(NOW / 1000) + 400000}}};
const profile = {account: {uuid: 'uuid-a', email: 'a@example.test'}, organization: {uuid: 'org-a'}};

// A fake provider: one reply per URL, a request log, no network.
function fakeProvider(replies) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({url, auth: options.headers.Authorization, redirect: options.redirect});
    const reply = typeof replies === 'function' ? replies(url, calls.length) : replies[new URL(url).pathname];
    return {status: reply.status, headers: {get: name => reply.headers?.[name] ?? null}, json: async () => reply.body};
  };
  return {calls, fetchImpl};
}
function fakeStore(initial) {
  const state = {...initial};
  return {state, credential: async key => { const c = state[key]; if (!c) throw Object.assign(new Error('x'), {code: 'usage_credential_unavailable'}); return {accountKey: key, ...c}; }};
}
const claudeCred = (extra = {}) => ({provider: 'claude', kind: 'oauth', generation: 'g1', bearer: 'synthetic-A', ...extra});
const ok = body => ({status: 200, body});
const claudeRoutes = {'/api/oauth/usage': ok(claudeUsage), '/api/oauth/profile': ok(profile)};

test('a Claude read parses unchanged, carries identity hashes and host-owned subscription evidence, and no stop', async () => {
  const net = fakeProvider(claudeRoutes), reader = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: net.fetchImpl, now: () => NOW});
  const result = await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(result.host_read, true);
  assert.equal(result.stop, undefined);
  assert.equal(result.executor, undefined);
  const parsed = parseProbeOutput('claude', result.stdout, NOW);
  assert.equal(parsed.status, 200);
  assert.deepEqual(parsed.readings.map(r => r.window_id).sort(), ['five_hour', 'seven_day']);
  assert.equal(parsed.extra_usage_state, 'disabled');
  assert.match(parsed.identity.account_sha256_16, /^[0-9a-f]{16}$/);
  assert.deepEqual(parsed.guest_auth, {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'});
  assert.ok(!result.stdout.includes('must-not-pass') && !result.stdout.includes('a@example.test') && !result.stdout.includes('synthetic-A'));
  assert.deepEqual(net.calls.map(c => new URL(c.url).pathname), ['/api/oauth/usage', '/api/oauth/profile']);
  assert.ok(net.calls.every(c => c.redirect === 'manual' && c.auth === 'Bearer synthetic-A'));
});

test('a Codex read takes plan, limit and identity from the one usage reply', async () => {
  const net = fakeProvider({'/backend-api/wham/usage': ok(codexUsage)});
  const reader = createUsageHostReader({store: fakeStore({codex: {provider: 'codex', kind: 'oauth', generation: 'g1', bearer: 'synthetic-C'}}), fetchImpl: net.fetchImpl, now: () => NOW});
  const parsed = parseProbeOutput('codex', (await reader.read({provider: 'codex', accountKey: 'codex'})).stdout, NOW);
  assert.equal(parsed.plan_type, 'plus');
  assert.equal(parsed.limit_reached, false);
  assert.ok(parsed.identity.account_sha256_16);
  assert.equal(parsed.guest_auth, null);
  assert.equal(net.calls.length, 1);
});

test('legacy Codex usage identity requires the same saved account and bearer email', async () => {
  const claims = {'https://api.openai.com/auth': {chatgpt_account_id: 'acct-1'},
    'https://api.openai.com/profile': {email: codexUsage.email}};
  const bearer = 'header.' + Buffer.from(JSON.stringify(claims)).toString('base64url') + '.signature';
  for (const [account, email, token, expected] of [
    ['acct-1', codexUsage.email, bearer, true],
    ['acct-2', codexUsage.email, bearer, false],
    ['acct-1', 'different@example.test', bearer, false],
    ['acct-1', undefined, bearer, false],
    ['acct-1', codexUsage.email, 'opaque', false],
  ]) {
    const net = fakeProvider({'/backend-api/wham/usage': ok({...codexUsage, account_id: '', email})});
    const store = fakeStore({codex: {provider: 'codex', kind: 'oauth', generation: 'g1', bearer: token, chatgptAccountId: account}});
    const reader = createUsageHostReader({store, fetchImpl: net.fetchImpl, now: () => NOW});
    const {stdout} = await reader.read({provider: 'codex', accountKey: 'codex'});
    assert.equal(Boolean(parseProbeOutput('codex', stdout, NOW).identity), expected);
    assert.equal(net.calls.length, 1);
    assert.ok(!stdout.includes(codexUsage.email) && !stdout.includes(token));
  }
});

test('the host request matches the guest probe request: same URL, same header names, same kept keys', () => {
  for (const provider of ['claude', 'codex']) {
    assert.equal(PROBE_REQUESTS[provider].url, PROVIDER_RECORDS[provider].usage.url);
    assert.deepEqual(PROBE_REQUESTS[provider].keep, PROVIDER_RECORDS[provider].usage.keep);
    const guestNames = Object.keys(PROBE_REQUESTS[provider].headers).filter(h => h !== 'Authorization').sort();
    assert.deepEqual(guestNames, Object.keys(PROVIDER_RECORDS[provider].usage.headers).sort());
  }
});

test('request budget: one usage GET per cycle; the Claude profile is read once per generation, again after a 401', async () => {
  let usageStatus = 200;
  const net = fakeProvider(url => new URL(url).pathname === '/api/oauth/usage' ? {status: usageStatus, body: claudeUsage} : ok(profile));
  const reader = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: net.fetchImpl, now: () => NOW});
  for (let i = 0; i < 120; i++) await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.deepEqual(reader.requests(), {usage: 120, identity: 1});
  usageStatus = 401; await reader.read({provider: 'claude', accountKey: 'claude'});
  usageStatus = 200; await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.deepEqual(reader.requests(), {usage: 122, identity: 2});
});

test('a new credential generation never reuses the old generation\'s identity', async () => {
  const store = fakeStore({claude: claudeCred()});
  const net = fakeProvider(claudeRoutes), reader = createUsageHostReader({store, fetchImpl: net.fetchImpl, now: () => NOW});
  await reader.read({provider: 'claude', accountKey: 'claude'});
  store.state.claude = claudeCred({generation: 'g2'});
  await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(reader.requests().identity, 2);
});

test('429 is retried at most twice, counted per cycle: Claude 3 (6 on rebind is 3 usage + 3 profile), Codex 3', async () => {
  const waits = [];
  const sleep = async ms => { waits.push(ms); };
  let net = fakeProvider(() => ({status: 429, headers: {}}));
  let reader = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: net.fetchImpl, now: () => NOW, sleep});
  const result = await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(parseProbeOutput('claude', result.stdout, NOW).status, 429);
  assert.equal(net.calls.length, 3);
  assert.deepEqual(waits, [5000, 10000]);
  waits.length = 0;
  net = fakeProvider(url => new URL(url).pathname === '/api/oauth/usage' ? ok(claudeUsage) : {status: 429, headers: {'retry-after': '99'}});
  reader = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: net.fetchImpl, now: () => NOW, sleep});
  await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(net.calls.length, 4);
  assert.deepEqual(waits, [15000, 15000]);
  net = fakeProvider(() => ({status: 429, headers: {}}));
  reader = createUsageHostReader({store: fakeStore({codex: {provider: 'codex', kind: 'oauth', generation: 'g', bearer: 'synthetic-C'}}), fetchImpl: net.fetchImpl, now: () => NOW, sleep});
  await reader.read({provider: 'codex', accountKey: 'codex'});
  assert.equal(net.calls.length, 3);
});

test('concurrent callers for one account and generation share one cycle', async () => {
  const net = fakeProvider(claudeRoutes), reader = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: net.fetchImpl, now: () => NOW});
  await Promise.all([1, 2, 3].map(() => reader.read({provider: 'claude', accountKey: 'claude'})));
  assert.deepEqual(reader.requests(), {usage: 1, identity: 1});
});

test('a 401 on one account leaves another account of the same provider unchanged', async () => {
  const id = '11111111-1111-4111-8111-111111111111', added = 'claude:' + id;
  const net = fakeProvider((url, n) => net.calls.at(-1).auth === 'Bearer synthetic-B' && new URL(url).pathname === '/api/oauth/usage'
    ? {status: 401} : claudeRoutes[new URL(url).pathname]);
  const reader = createUsageHostReader({store: fakeStore({claude: claudeCred(), [added]: claudeCred({kind: 'setup-token', bearer: 'synthetic-B'})}),
    fetchImpl: net.fetchImpl, now: () => NOW});
  const a = parseProbeOutput('claude', (await reader.read({provider: 'claude', accountKey: 'claude'})).stdout, NOW);
  const b = parseProbeOutput('claude', (await reader.read({provider: 'claude', accountKey: added})).stdout, NOW);
  assert.equal(a.status, 200); assert.equal(b.status, 401);
  assert.equal(parseProbeOutput('claude', (await reader.read({provider: 'claude', accountKey: 'claude'})).stdout, NOW).status, 200);
  assert.ok(net.calls.filter(c => c.auth === 'Bearer synthetic-B').length === 1);
});

test('missing credential, API-key account and wrong provider read nothing and send no request', async () => {
  const net = fakeProvider(claudeRoutes);
  const reader = createUsageHostReader({store: fakeStore({claude: claudeCred({kind: 'api-key'}), codex: claudeCred()}), fetchImpl: net.fetchImpl});
  for (const accountKey of ['claude', 'codex', 'claude:11111111-1111-4111-8111-111111111111'])
    await assert.rejects(reader.read({provider: accountKey === 'codex' ? 'codex' : 'claude', accountKey}), error => error.probe_failure === 'probe_unavailable');
  assert.equal(net.calls.length, 0);
});

test('a host outside the record\'s list gets no token, and a redirect is not followed', async () => {
  const net = fakeProvider(claudeRoutes);
  const bad = {claude: {...PROVIDER_RECORDS.claude, hosts: ['example.test']}};
  const reader = createUsageHostReader({store: fakeStore({claude: claudeCred()}), records: bad, fetchImpl: net.fetchImpl});
  await assert.rejects(reader.read({provider: 'claude', accountKey: 'claude'}), error => error.code === 'host_not_allowed');
  assert.equal(net.calls.length, 0);
  const redirect = fakeProvider(() => ({status: 302, headers: {location: 'https://evil.test/'}}));
  const r2 = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: redirect.fetchImpl});
  const out = await r2.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(redirect.calls.length, 1);
  assert.equal(parseProbeOutput('claude', out.stdout, NOW).status, 0);
});

test('a reply that finishes after the credential changed is discarded', async () => {
  const store = fakeStore({claude: claudeCred()});
  const net = fakeProvider(url => { if (new URL(url).pathname === '/api/oauth/usage') store.state.claude = claudeCred({generation: 'g2'}); return claudeRoutes[new URL(url).pathname]; });
  const reader = createUsageHostReader({store, fetchImpl: net.fetchImpl});
  await assert.rejects(reader.read({provider: 'claude', accountKey: 'claude'}), error => error.probe_failure === 'cancelled');
});

test('an abort ends the caller\'s wait at once and a network failure reads as a failed observation, not a throw', async () => {
  const hang = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: () => new Promise(() => {})});
  const controller = new AbortController();
  const waiting = hang.read({provider: 'claude', accountKey: 'claude', signal: controller.signal});
  controller.abort();
  await assert.rejects(waiting, error => error.probe_failure === 'cancelled');
  const down = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: async () => { throw new TypeError('fetch failed'); }});
  const parsed = parseProbeOutput('claude', (await down.read({provider: 'claude', accountKey: 'claude'})).stdout, NOW);
  assert.equal(parsed.status, -1); assert.equal(parsed.probe.failure_class, 'network_error');
});

test('a test-only third provider record reads usage with no reader change', async () => {
  const record = {parser: 'test', hosts: ['usage.example.test'], usage: {url: 'https://usage.example.test/u', headers: {}, keep: {used: true}},
    identity: null, subscriptionKinds: ['oauth'], windowKeys: []};
  const net = fakeProvider({'/u': ok({used: 'yes', secret: 'x'})});
  const reader = createUsageHostReader({store: fakeStore({third: {provider: 'third', kind: 'oauth', generation: 'g', bearer: 'synthetic-T'}}),
    records: {third: record}, fetchImpl: net.fetchImpl});
  const out = JSON.parse((await reader.read({provider: 'third', accountKey: 'third'})).stdout);
  assert.deepEqual(out.body, {used: 'yes'});
});

test('the reading is stamped with the request time, not the time a slow answer arrived', async () => {
  let clock = NOW;
  const net = fakeProvider(url => { clock += 45_000; return claudeRoutes[new URL(url).pathname]; });
  const reader = createUsageHostReader({store: fakeStore({claude: claudeCred()}), fetchImpl: net.fetchImpl, now: () => clock});
  const result = await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.equal(result.usage_seen_at, NOW);
});

test('a known-expired credential that cannot be refreshed reads unknown and is never sent', async () => {
  const cases = [
    ['no refresher', undefined],
    ['refresh fails', {isDue: () => true, refresh: async () => ({ok: false, reason: 'refresh_unavailable', account_state: 'retry'})}],
  ];
  for (const [name, refresher] of cases) {
    const net = fakeProvider(claudeRoutes);
    const store = fakeStore({claude: claudeCred({expiresAt: NOW - 1000, refresh: 'synthetic-refresh'})});
    const reader = createUsageHostReader({store, refresher, fetchImpl: net.fetchImpl, now: () => NOW});
    await assert.rejects(reader.read({provider: 'claude', accountKey: 'claude'}), error => error.reason === 'credential_expired' || /credential_expired/.test(JSON.stringify(error)), name);
    assert.equal(net.calls.length, 0, name + ': no request carried the expired token');
  }
});

test('an expired credential that the refresh replaces is read with the new token', async () => {
  const net = fakeProvider(claudeRoutes), store = fakeStore({claude: claudeCred({expiresAt: NOW - 1000, refresh: 'synthetic-refresh'})});
  const refresher = {isDue: () => true, refresh: async () => { store.state.claude = claudeCred({bearer: 'synthetic-B', generation: 'g2', expiresAt: NOW + 3600e3}); return {ok: true}; }};
  const reader = createUsageHostReader({store, refresher, fetchImpl: net.fetchImpl, now: () => NOW});
  await reader.read({provider: 'claude', accountKey: 'claude'});
  assert.ok(net.calls.length > 0 && net.calls.every(c => c.auth === 'Bearer synthetic-B'));
});
