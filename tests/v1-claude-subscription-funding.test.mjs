import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as meter from '../lib/v1/lending-meter.mjs';
import * as probeModule from '../lib/v1/lending-probe.mjs';

const T = Date.parse('2026-10-23T05:00:00Z');

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
