import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {appFixture, api, syntheticBackend} from './helpers/v1-app-fixture.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';
import {probeFailureCopy, identityHoldCopy} from '../lib/v1/lending-status-copy.mjs';
import {lendingReadiness} from '../lib/v1/lending-readiness.mjs';

// Item 12: readiness rows and manual refresh are per account. Two Claude accounts, fake runner, no provider call.
async function twoAccounts(t, {runner, hostReader} = {}) {
  const f = await appFixture(t), backend = syntheticBackend(f.root);
  let probes = 0;
  const {app} = await f.start('owner', {backend,
    adapters: () => [{spec: legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true, models: ['claude-sonnet-5-5'], capabilities: []}],
    identityProbe: async () => ({providers: [{harness_id: 'claude-code-subscription', installed: true, signedIn: true}]}),
    ...(hostReader ? {lendingHostReader: hostReader} : {}),
    lendingProbeRunner: async args => { probes++; return runner ? runner(args) : {probe_failure: 'guest_failed', stdout: 'private guest output'}; }});
  await api(app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  // The registry handle stands in for the account-adding screen, which this slice does not touch.
  const registry = app.lendingAccounts().registry();
  const added = registry.add({provider: 'claude', label: 'B work'});
  registry.setEnabled(added.id, true);
  return {app, added, registry, probes: () => probes};
}

// The usage note states the saved reading's age in milliseconds, which moves between two reads. The rest of the row must not.
const unaged = row => JSON.parse(JSON.stringify(row).replace(/is \d+ ms old/g, 'is N ms old'));

test('readiness has one row per account, each with its own key, label and retry time', {timeout: 60000}, async t => {
  const {app, added} = await twoAccounts(t);
  const {agents} = await api(app, '/api/lending/readiness');
  const rows = agents.filter(row => row.provider === 'claude');
  assert.deepEqual(rows.map(row => row.accountKey).sort(), ['claude', 'claude:' + added.id].sort());
  assert.deepEqual(rows.find(row => row.accountKey === 'claude:' + added.id).accountLabel, 'B work');
  assert.ok(rows.every(row => row.retryAt === null && row.id === 'claude-code-subscription'));
  // Two accounts of one provider: each fix names its account.
  const b = rows.find(row => row.accountKey === 'claude:' + added.id);
  // The check list no longer carries a weekly-window row: stale or missing usage is not a hold (SPEC 3). The sign-in check still names its account.
  assert.match(b.checks.find(check => check.id === 'signed_in').fix, /B work/);
});

test('a refresh names one account: only that account is read and only its result comes back', {timeout: 60000}, async t => {
  const {app, added, probes} = await twoAccounts(t);
  const before = await api(app, '/api/lending/readiness');
  const rowB = before.agents.find(row => row.accountKey === 'claude:' + added.id);
  const rows = await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: ['claude:' + added.id]}});
  const claude = rows.find(row => row.id === 'claude-code-subscription');
  assert.deepEqual(claude.accounts.map(a => a.accountKey), ['claude:' + added.id]);
  assert.equal(claude.capacity, undefined, 'the first account was not refreshed');
  assert.equal(probes(), 0, 'no usage request was made for the first account');
  const afterB = await api(app, '/api/lending/readiness');
  assert.deepEqual(afterB.agents.find(row => row.accountKey === 'claude'), before.agents.find(row => row.accountKey === 'claude'), 'the first account row is unchanged');
  assert.equal(afterB.agents.find(row => row.accountKey === 'claude:' + added.id).accountLabel, rowB.accountLabel);
  const second = await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: ['claude']}});
  const row = second.find(r => r.id === 'claude-code-subscription');
  assert.deepEqual(row.accounts.map(a => a.accountKey), ['claude']);
  assert.ok(probes() >= 1, 'the named account was read');
  assert.equal(row.accounts[0].capacity.reason, 'refresh_failed');
});

test('an unknown, removed, disabled or mixed refresh target is refused with no usage call and no fallback', {timeout: 60000}, async t => {
  const {app, added, registry, probes} = await twoAccounts(t);
  const refuse = body => api(app, '/api/agents/refresh', {method: 'POST', body, status: 400});
  await refuse({accounts: ['claude:00000000-0000-4000-8000-000000000000']});
  await refuse({accounts: ['codex']});
  await refuse({accounts: []});
  await refuse({accounts: ['not a key']});
  await refuse({accounts: ['claude'], agents: ['claude-code-subscription']});
  registry.setEnabled(added.id, false);
  await refuse({accounts: ['claude:' + added.id]});
  assert.equal(probes(), 0);
  const {agents} = await api(app, '/api/lending/readiness');
  assert.deepEqual(agents.map(row => row.accountKey), ['claude'], 'a disabled account has no row');
});

test('a disabled or removed account gets no further reads, from any route', {timeout: 60000}, async t => {
  const asked = [];
  // The app's host reader is a recording fake: every read, for any account and any route, names its account here.
  const hostReader = {read: async ({accountKey}) => { asked.push(accountKey); throw Object.assign(new Error('fake'), {probe_failure: 'probe_unavailable'}); }, verify: async () => ({ok: false})};
  const {app, added, registry, probes} = await twoAccounts(t, {hostReader});
  const key = 'claude:' + added.id;
  await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: [key]}});
  assert.ok(asked.includes(key), 'while enabled, the account is read');
  registry.setEnabled(added.id, false);
  asked.length = 0;
  await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: ['claude']}});
  await api(app, '/api/lending/readiness');
  await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: [key]}, status: 400});
  registry.markRemoved(added.id);
  await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: ['claude']}});
  await api(app, '/api/lending/readiness');
  await api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: [key]}, status: 400});
  assert.ok(!asked.includes(key), 'no read named the disabled or removed account: ' + asked.join(','));
  assert.ok(probes() > 0, 'the other account is still read');
});

test('copy names the account: sign in again to it, its retry time, its identity hold', () => {
  assert.equal(probeFailureCopy({outcome: 'failed', reason: 'auth'}, {accountLabel: 'A personal'}).action, 'Sign in again to A personal.');
  assert.match(probeFailureCopy({outcome: 'failed', reason: 'auth'}, {accountLabel: 'A personal'}).line, /A personal's allowance/);
  assert.equal(probeFailureCopy({outcome: 'failed', reason: 'auth'}).action, 'Sign in again and refresh the allowance.');
  const at = Date.UTC(2026, 10, 12, 1);
  assert.match(probeFailureCopy({outcome: 'failed', reason: 'rate_limited'}, {accountLabel: 'B work', retryAt: at}).action, /Wait until 2026-11-12T01:00:00.000Z.*B work/);
  assert.doesNotMatch(probeFailureCopy({outcome: 'failed', reason: 'rate_limited'}, {accountLabel: 'B work', retryAt: 'x'}).action, /Invalid Date|undefined/);
  const hold = identityHoldCopy('identity_mismatch', {provider: 'claude', accountLabel: 'A personal'});
  assert.equal(hold.action, 'Sign in again to A personal');
  assert.doesNotMatch(hold.line, /off and on/);
  assert.match(identityHoldCopy('identity_mismatch', {provider: 'claude'}).line, /off and on/, 'one account keeps the provider copy');
  const checks = lendingReadiness({signedIn: false, provider: 'claude', accountLabel: 'A personal', observation: {}});
  assert.equal(checks.find(c => c.id === 'signed_in').fix, 'Sign in again to A personal.');
});

// Two accounts of one provider, each read from the host through its own key. A fake host reader answers per account.
function hostLine(status, who) {
  const hours = h => new Date(Date.now() + h * 3600e3).toISOString();
  return JSON.stringify({faravan_probe: 1, status, body: status === 200 ? {five_hour: {utilization: 10, resets_at: hours(2)},
    seven_day: {utilization: 20, resets_at: hours(80)}, extra_usage: {is_enabled: false}} : {},
  ...(status === 200 ? {identity: {status: 200, account_sha256_16: who.repeat(16).slice(0, 16), email_sha256_16: who.repeat(16).slice(0, 16)},
    guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}} : {})}) + '\n';
}
let aId = null;
async function hostTwo(t, {usageStore, signedIn = true} = {}) {
  const answers = new Map(), calls = [];
  const lendingHostReader = {async read({provider, accountKey}) {
    calls.push(accountKey);
    const status = answers.get(accountKey) ?? 200;
    return {exitCode: 0, stdout: hostLine(status, accountKey.endsWith(String(aId)) ? 'a' : 'b'), usage_seen_at: Date.now(), host_read: true, account_key: accountKey, generation: 'g1'};
  }, verify: async () => ({ok: false})};
  const f = await appFixture(t), backend = syntheticBackend(f.root);
  const {app} = await f.start('owner', {backend, lendingHostReader, ...(usageStore ? {lendingUsageStore: usageStore} : {}),
    adapters: () => [{spec: legacyProxyHarness('claude-code-subscription'), installed: true, signedIn, models: ['claude-sonnet-5-5'], capabilities: []}],
    identityProbe: async () => ({providers: [{harness_id: 'claude-code-subscription', installed: true, signedIn}]})});
  await api(app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  const registry = app.lendingAccounts().registry();
  const a = registry.add({provider: 'claude', label: 'A personal'}), b = registry.add({provider: 'claude', label: 'B work'});
  aId = a.id; registry.setEnabled(a.id, true); registry.setEnabled(b.id, true);
  return {app, a, b, answers, calls, keyA: 'claude:' + a.id, keyB: 'claude:' + b.id};
}

test('two accounts of one provider: A fails to read, B is unchanged and A says so with its own label', {timeout: 90000}, async t => {
  const {app, answers, calls, keyA, keyB} = await hostTwo(t);
  const refresh = key => api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: [key]}});
  const row = async key => (await api(app, '/api/lending/readiness')).agents.find(r => r.accountKey === key);
  await refresh(keyA); await refresh(keyB);
  assert.deepEqual([...new Set(calls)].sort(), [keyA, keyB].sort(), 'each refresh read only its own account');
  const baselineB = await row(keyB);
  assert.equal(baselineB.hasReading, true, 'B has its own reading');
  assert.equal((await row(keyA)).hasReading, true);
  const callsBefore = calls.length;
  answers.set(keyA, 401);
  const result = (await refresh(keyA)).find(r => r.id === 'claude-code-subscription');
  assert.deepEqual(calls.slice(callsBefore), [keyA], 'only A was read');
  assert.equal(result.accounts[0].accountKey, keyA);
  assert.equal(result.accounts[0].capacity.reason, 'refresh_failed');
  const failedA = await row(keyA), sameB = await row(keyB);
  assert.equal(failedA.probe_outcome.outcome, 'failed');
  assert.equal(failedA.probe_outcome.reason, 'auth');
  assert.equal(failedA.accountLabel, 'A personal');
  assert.match(failedA.checks.find(c => c.state !== 'pass' && /A personal/.test(c.line + c.fix))?.fix ?? '', /Sign in again to A personal\./);
  assert.deepEqual(unaged(sameB), unaged(baselineB), "B's row, reading and checks are exactly as before");
  assert.equal(sameB.probe_outcome.outcome, 'good');
  assert.ok(!JSON.stringify(sameB).includes('A personal'), "A's label never appears on B");
});

test('sign-in evidence is per account: the first account signed out leaves B ready, and A signed out never marks B', {timeout: 90000}, async t => {
  const signedOut = new Set();
  const usageStore = {credential: async key => {
    if (signedOut.has(key)) throw Object.assign(new Error('x'), {code: 'usage_credential_unavailable', reason: 'not_signed_in'});
    return {accountKey: key, kind: 'setup-token', generation: 'g1'};
  }};
  const {app, keyA, keyB} = await hostTwo(t, {usageStore, signedIn: false});   // the agent's own (first account) sign-in is out
  const refresh = key => api(app, '/api/agents/refresh', {method: 'POST', body: {accounts: [key]}});
  await refresh(keyA); await refresh(keyB);
  const rows = async () => (await api(app, '/api/lending/readiness')).agents;
  const signed = (all, key) => all.find(r => r.accountKey === key).checks.find(c => c.id === 'signed_in');
  let all = await rows();
  assert.equal(signed(all, 'claude').state, 'fail', 'the first account is signed out');
  assert.equal(signed(all, keyB).state, 'pass', "B is signed in whatever the first account's state is");
  assert.equal(signed(all, keyA).state, 'pass');
  const cleanB = all.find(r => r.accountKey === keyB);
  assert.ok(cleanB.checks.every(c => c.state !== 'fail'), 'B has no failing check');
  assert.ok(!JSON.stringify(cleanB).includes('Sign in again'), 'no sign-in text on B');
  signedOut.add(keyA);
  all = await rows();
  assert.equal(signed(all, keyA).state, 'fail');
  assert.match(signed(all, keyA).fix, /Sign in again to A personal\./);
  assert.deepEqual(unaged(all.find(r => r.accountKey === keyB)), unaged(cleanB), "A signing out leaves B's row exactly as it was");
});

// Two-account copy: every non-passing check names its account in the line or the fix, and a passing line names it too.
const OBS_SEEN = {refresh_succeeded: true, complete: true, resources: [{id: 'seven_day', kind: 'weekly', resets_at: 9e12, observed_at: 1}], identity: {verified: true},
  funding: {subscription_only: true}, executor: {single_executor: true}, stop: {bounded_execution: true}, epoch: 1, account_week_id: 'w'};
const TABLE = [
  ['signed_in', {signedIn: false}],
  ['signed_in', {signedIn: null}],
  ['account', {observation: {...OBS_SEEN, identity: {verified: false, reason: 'identity_unobserved'}}}],
  ['subscription', {observation: {...OBS_SEEN, funding: {subscription_only: 'unknown', reason: 'plan_not_subscription'}}}],
  ['weekly_window', {observation: {refresh_succeeded: false}}],
  ['conversion', {observation: {refresh_succeeded: false}}],
  ['job_control', {observation: {refresh_succeeded: false}}],
];
for (const [id, input] of TABLE) {
  test(`two-account copy: the ${id} check names the account (${JSON.stringify(input).slice(0, 50)})`, () => {
    const check = lendingReadiness({provider: 'claude', signedIn: true, accountLabel: 'B work', observation: {refresh_succeeded: false}, ...input}).find(c => c.id === id);
    assert.notEqual(check.state, 'pass');
    assert.match((check.line ?? '') + ' ' + (check.fix ?? ''), /B work/, `${id}: ${check.line} / ${check.fix}`);
    const single = lendingReadiness({provider: 'claude', signedIn: true, accountLabel: null, observation: {refresh_succeeded: false}, ...input}).find(c => c.id === id);
    assert.ok(!/B work/.test((single.line ?? '') + (single.fix ?? '')), 'one account: no label');
  });
}
