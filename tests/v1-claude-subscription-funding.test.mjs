import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as meter from '../lib/v1/lending-meter.mjs';
import * as probeModule from '../lib/v1/lending-probe.mjs';
import * as sourceModule from '../lib/v1/lending-pace50-source.mjs';

const T = Date.parse('2026-10-23T05:00:00Z');
const CLAUDE_AUTH = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };
const usageBody = (extra = {}) => ({
  five_hour: { utilization: 13, resets_at: '2026-10-23T10:00:00Z' },
  seven_day: { utilization: 3, resets_at: '2026-10-30T05:00:00Z' },
  ...extra,
});
const probeLine = (status, body) => `{"faravan_probe":1,"status":${status},"body":${JSON.stringify(body)}}`;

test('a usage reading states extra usage only when the provider sends it explicitly', () => {
  assert.equal(meter.parseClaudeUsage(usageBody({ extra_usage: { is_enabled: false } }), T).extra_usage_state, 'disabled');
  assert.equal(meter.parseClaudeUsage(usageBody({ extra_usage: { is_enabled: true } }), T).extra_usage_state, 'enabled');
  // The existing boolean coerces an absent field to false. The state must not repeat that coercion.
  const absent = meter.parseClaudeUsage(usageBody(), T);
  assert.equal(absent.extra_usage_enabled, false);
  assert.equal(absent.extra_usage_state, 'absent');
  assert.equal(meter.parseClaudeUsage(usageBody({ extra_usage: { is_enabled: 'false' } }), T).extra_usage_state, 'invalid');
  assert.equal(meter.parseClaudeUsage(usageBody({ extra_usage: null }), T).extra_usage_state, 'invalid');
});

test('subscription-only funding is proven only for an explicit disabled reading on the claude.ai first-party login', () => {
  assert.deepEqual(sourceModule.claudeSubscriptionFunding({ extraUsage: 'disabled', guestAuth: CLAUDE_AUTH }), { subscription_only: 'proven', reason: null });
  const refusals = [
    ['enabled', CLAUDE_AUTH, 'extra_usage_enabled'],
    ['absent', CLAUDE_AUTH, 'extra_usage_unobserved'],
    ['invalid', CLAUDE_AUTH, 'extra_usage_unobserved'],
    [undefined, CLAUDE_AUTH, 'extra_usage_unobserved'],
    ['disabled', undefined, 'guest_auth_not_claude_ai'],
    ['disabled', { ...CLAUDE_AUTH, loggedIn: false }, 'guest_auth_not_claude_ai'],
    ['disabled', { ...CLAUDE_AUTH, authMethod: 'api_key' }, 'guest_auth_not_claude_ai'],
    ['disabled', { loggedIn: true, authMethod: 'claude.ai' }, 'guest_provider_unobserved'],
    ['disabled', { ...CLAUDE_AUTH, apiProvider: 'bedrock' }, 'alternative_api_provider'],
  ];
  for (const [extraUsage, guestAuth, reason] of refusals) {
    assert.deepEqual(sourceModule.claudeSubscriptionFunding({ extraUsage, guestAuth }), { subscription_only: 'unknown', reason },
      JSON.stringify([extraUsage, guestAuth]));
  }
});

test('the usage probe retains its last successful funding reading across failed background probes', async () => {
  let reply;
  let now = T;
  const probe = probeModule.createLendingProbe({
    runGuest: async () => { if (reply instanceof Error) throw reply; return reply; },
    now: () => now,
  });
  assert.equal(probe.funding('claude'), null, 'no reading before any probe');

  reply = { stdout: probeLine(200, usageBody({ extra_usage: { is_enabled: false } })) };
  assert.equal((await probe.probe('claude')).ok, true);
  assert.deepEqual(probe.funding('claude'), { extra_usage: 'disabled', observed_at: T, identity: null });

  now = T + 60000;
  reply = { stdout: probeLine(200, usageBody()) };
  await probe.probe('claude');
  assert.deepEqual(probe.funding('claude'), { extra_usage: 'absent', observed_at: T + 60000, identity: null }, 'an absent field is never inherited as disabled');

  reply = { stdout: probeLine(200, usageBody({ extra_usage: { is_enabled: false } })) };
  await probe.probe('claude');
  reply = { stdout: probeLine(429, {}) };
  await probe.probe('claude');
  // Optional background failures do not erase the facts paired with cached quota.
  assert.deepEqual(probe.funding('claude'), {extra_usage:'disabled', observed_at:T + 60000, identity:null});
  assert.equal(probe.lastResult('claude').reason, 'rate_limited');

  reply = { stdout: probeLine(200, usageBody({ extra_usage: { is_enabled: false } })) };
  await probe.probe('claude');
  assert.equal(probe.funding('claude')?.extra_usage, 'disabled');
  reply = new Error('guest down');
  assert.equal((await probe.probe('claude')).ok, false);
  assert.deepEqual(probe.funding('claude'), {extra_usage:'disabled', observed_at:T + 60000, identity:null});
  assert.equal(probe.lastResult('claude').ok, false);
});

test('funding reaches the real source only from the same probe run as the windows, and never admits alone', async () => {
  const windows = [
    { window_id: 'seven_day', window_minutes: 10080, used_pct: 3, resets_at: T + 7 * 86400000, observed_at: T, state: 'open' },
    { window_id: 'five_hour', window_minutes: 300, used_pct: 13, resets_at: T + 5 * 3600000, observed_at: T, state: 'open' },
  ];
  const source = sourceModule.createRealPace50Source({
    readings: async () => ({ windows }),
    funding: async () => ({ extra_usage: 'disabled', observed_at: T, guest_auth: CLAUDE_AUTH }),
  });
  const observation = await source.observe({ provider: 'claude' });
  assert.deepEqual(observation.funding, { subscription_only: 'proven', reason: null });
  // Identity is still unverified, so the pace input refuses on identity, and funding alone never admits.
  assert.deepEqual(sourceModule.paceInputFromObservation(observation, { now: T, context: {} }), { refuse: 'identity_unknown' });

  const stale = sourceModule.createRealPace50Source({
    readings: async () => ({ windows }),
    funding: async () => ({ extra_usage: 'disabled', observed_at: T - 60000, guest_auth: CLAUDE_AUTH }),
  });
  assert.deepEqual((await stale.observe({ provider: 'claude' })).funding,
    { subscription_only: 'unknown', reason: 'funding_unobserved' }, 'a reading from another run is not this run\'s funding');

  const thrown = sourceModule.createRealPace50Source({
    readings: async () => ({ windows }),
    funding: async () => { throw new Error('probe unavailable'); },
  });
  assert.equal((await thrown.observe({ provider: 'claude' })).funding.subscription_only, 'unknown');
});
