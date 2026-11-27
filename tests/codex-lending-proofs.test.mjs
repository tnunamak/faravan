import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createLendingProbe, guestProbeScript} from '../lib/v1/lending-probe.mjs';
import {codexSubscriptionFunding, createRealPace50Source, paceInputFromObservation} from './helpers/real-source.mjs';

// Codex lending needs the same proofs as Claude: the enrolled account, subscription-only funding, the weekly window and a
// conversion. The usage reply (wham/usage) carries the account, the plan and the windows; the guest prints only hashes.
const NOW = Date.UTC(2026, 9, 30, 21, 0, 0);
const ACCOUNT = 'a1b2c3d4e5f60718', EMAIL = '0123456789abcdef';
const usageLine = ({plan = 'pro', limitReached = false, allowed = true, spend = false, identity = {status: 200,
  account_sha256_16: ACCOUNT, email_sha256_16: EMAIL}} = {}) => JSON.stringify({faravan_probe: 1, status: 200,
  body: {plan_type: plan, rate_limit: {allowed, limit_reached: limitReached, secondary_window: null,
    primary_window: {used_percent: 57, limit_window_seconds: 604800, reset_after_seconds: 3 * 86400}},
  credits: {has_credits: true}, spend_control: {reached: spend}},
  attempts: {usage: 1, identity: 0}, ...(identity ? {identity} : {})});

async function probeFact(line) {
  const probe = createLendingProbe({runGuest: async () => ({exitCode: 0, stdout: line + '\n',
    executor: {backend_id: 'docker-sbx', sbx_version: '0.50.1'}, stop: {delivered: true, fallback: null, latency_ms: 900, removed: true}}),
  now: () => NOW});
  const result = await probe.probe('codex');
  assert.equal(result.ok, true);
  return {probe, readings: result.readings};
}

function sourceFor({probe, readings}, expected = {account_sha256_16: ACCOUNT}, kappaForUsage = null) {
  return createRealPace50Source({readings: async () => ({refresh_succeeded: true, windows: readings}),
    funding: provider => probe.funding(provider), expectedIdentity: () => expected,
    expectedExecutor: {backend_id: 'docker-sbx', accepts: v => v === '0.50.1'}, stopBoundMs: 35_000, kappaForUsage});
}
const context = {consent: true, people: true, agents: true, schedule: true, unexpired: true, intent: 'on', paused: false, ownerAbsent: true};

test('the Codex guest probe hashes the account id and e-mail from the usage reply, never printing them', () => {
  const script = guestProbeScript('codex');
  assert.match(script, /=="codex" and status==200/);
  assert.match(script, /\("account_sha256_16","account_id"\),\("email_sha256_16","email"\)/);
  assert.doesNotMatch(script, /print\([^)]*account_id/);
});

const measured = (upper = 200_000, account = ACCOUNT) => () => ({upper_micro: upper, lower_micro: null,
  binding: {account_sha256_16: account, since: NOW - 86400_000}, provenance: {method: 'current-window', label: 'measured from your usage'}});

test('a Pro account below its limit, signed in as the enrolled account, lends at once in its own points and converts after its own measurement', async () => {
  const unmeasured = await sourceFor(await probeFact(usageLine())).observe({provider: 'codex', model: 'gpt-6-sol', now: NOW});
  assert.deepEqual(unmeasured.identity, {verified: true, account_id: ACCOUNT, reason: null});
  assert.equal(unmeasured.funding.subscription_only, 'proven');
  assert.equal(unmeasured.weekly_resource_id, 'codex:10080');
  assert.match(unmeasured.account_week_id, new RegExp(`^${ACCOUNT}:weekly:`));
  assert.equal(unmeasured.resources[0].kappa_micro, null, 'the plan the provider names is not a rate');
  assert.equal(unmeasured.resources[0].conversion, 'native_window');
  assert.deepEqual(unmeasured.learning, [{reason: 'learning', provider: 'codex', window: 'weekly'}]);
  assert.equal(unmeasured.calibration_missing, undefined, 'no measurement is not a hold');
  assert.equal(paceInputFromObservation(unmeasured, {now: NOW, context}).refuse, undefined, 'it lends in native-window mode');
  const obs = await sourceFor(await probeFact(usageLine()), undefined, measured()).observe({provider: 'codex', model: 'gpt-6-sol', now: NOW});
  assert.equal(obs.resources[0].kappa_micro, 200_000);
  const input = paceInputFromObservation(obs, {now: NOW, context});
  assert.equal(input.refuse, undefined, JSON.stringify(input));
  assert.equal(input.account, ACCOUNT);
});

test('another signed-in Codex account refuses as a mismatch', async () => {
  const obs = await sourceFor(await probeFact(usageLine()), {account_sha256_16: 'ffffffffffffffff'})
    .observe({provider: 'codex', model: 'gpt-6-sol', now: NOW});
  assert.equal(obs.identity.reason, 'identity_mismatch');
  assert.equal(paceInputFromObservation(obs, {now: NOW, context}).refuse, 'identity_mismatch');
});

test('a usage reply without the account stays identity unknown', async () => {
  const obs = await sourceFor(await probeFact(usageLine({identity: null}))).observe({provider: 'codex', model: 'gpt-6-sol', now: NOW});
  assert.equal(obs.identity.verified, false);
  assert.equal(paceInputFromObservation(obs, {now: NOW, context}).refuse, 'identity_unknown');
});

test('a free plan, a reached limit or a reached spend control is not subscription-only funding', async () => {
  for (const [line, reason] of [[usageLine({plan: 'free'}), 'plan_not_subscription'], [usageLine({limitReached: true}), 'limit_reached'],
    [usageLine({spend: true}), 'limit_reached'], [usageLine({allowed: false}), 'limit_reached']]) {
    const obs = await sourceFor(await probeFact(line)).observe({provider: 'codex', model: 'gpt-6-sol', now: NOW});
    assert.equal(obs.funding.reason, reason, reason);
    assert.equal(paceInputFromObservation(obs, {now: NOW, context}).refuse, 'funding_unknown');
  }
  assert.equal(codexSubscriptionFunding(null).reason, 'plan_unobserved');
  assert.equal(codexSubscriptionFunding({plan_type: 'pro'}).reason, 'limit_unobserved');
});

test('a plan with no measured conversion lends in native-window mode, with no rate invented', async () => {
  const obs = await sourceFor(await probeFact(usageLine({plan: 'plus'}))).observe({provider: 'codex', model: 'gpt-6-sol', now: NOW});
  assert.equal(obs.funding.subscription_only, 'proven');
  assert.equal(obs.resources[0].kappa_micro, null);
  assert.equal(obs.resources[0].conversion, 'native_window');
  assert.equal(paceInputFromObservation(obs, {now: NOW, context}).refuse, undefined);
});

test('any plan label converts by the account\'s own measurement, and the shipped bound is only a floor', async () => {
  for (const [providerPlan, ownerPlan] of [['pro', 'plus'], ['plus', 'pro'], ['team', null], ['business', 'unknown']]) {
    const fact = await probeFact(usageLine({plan: providerPlan}));
    const low = await sourceFor(fact, undefined, measured(100)).observe({provider: 'codex', model: 'gpt-6-sol', plan: ownerPlan, now: NOW});
    assert.equal(low.resources[0].kappa_micro, 135_700, `${providerPlan}: the largest shipped bound is a floor`);
    assert.equal(low.resources[0].kappa_provenance.label, 'shipped bound');
    const high = await sourceFor(fact, undefined, measured(500_000)).observe({provider: 'codex', model: 'gpt-6-sol', plan: ownerPlan, now: NOW});
    assert.equal(high.resources[0].kappa_micro, 500_000, `${providerPlan}: a higher measurement wins`);
    assert.deepEqual(high.account_plan, {plan: providerPlan, source: 'provider'}, 'the plan stays a label');
    assert.equal(paceInputFromObservation(high, {now: NOW, context}).refuse, undefined);
  }
  const absent = await sourceFor(await probeFact(usageLine({plan: null})), undefined, measured())
    .observe({provider: 'codex', model: 'gpt-6-sol', plan: 'pro', now: NOW});
  assert.deepEqual(absent.account_plan, {plan: null, source: null});
  assert.equal(absent.funding.subscription_only, 'unknown', 'owner configuration cannot prove provider funding');
  assert.equal(paceInputFromObservation(absent, {now: NOW, context}).refuse, 'funding_unknown');
});

test('a measurement made on another account, or with no account binding, never converts: the window lends natively', async () => {
  const fact = await probeFact(usageLine({plan: 'plus'}));
  const args = {provider: 'codex', model: 'gpt-6-sol', plan: 'pro', now: NOW};
  const lookups = [];
  for (const candidate of [measured(500_000, 'ffffffffffffffff')(), {upper_micro: 500_000, provenance: {}}]) {
    const obs = await sourceFor(fact, undefined, lookup => { lookups.push(lookup); return candidate; }).observe(args);
    assert.equal(obs.resources[0].kappa_micro, null);
    assert.equal(obs.resources[0].kappa_rejection_code, 'binding_mismatch');
    assert.doesNotMatch(obs.resources[0].kappa_rejection_code, /ffff/);
    assert.equal(obs.resources[0].conversion, 'native_window');
    assert.equal(paceInputFromObservation(obs, {now: NOW, context}).refuse, undefined);
  }
  assert.ok(lookups.every(lookup => lookup.account_id === ACCOUNT && !('plan' in lookup) && !('provider_plan' in lookup)));
});

test('a measurement persists across window resets and later readings of the same account', async () => {
  const reply = JSON.parse(usageLine({plan: 'plus'}));
  reply.body.rate_limit.secondary_window = {used_percent: 57, limit_window_seconds: 18000, reset_after_seconds: 3600};
  const fact = await probeFact(JSON.stringify(reply));
  const later = NOW + 2 * 86400_000;
  const changed = {readings: fact.readings.map(r => ({...r, observed_at: later,
    resets_at: (typeof r.resets_at === 'number' ? r.resets_at : Date.parse(r.resets_at)) + 5 * 3600_000})),
    probe: {funding: provider => ({...fact.probe.funding(provider), observed_at: later})}};
  for (const input of [fact, changed]) {
    const obs = await sourceFor(input, undefined, measured(150_000)).observe({provider: 'codex', model: 'gpt-6-sol', now: later});
    assert.deepEqual(obs.resources.map(r => r.kappa_micro), [150_000, 150_000]);
  }
});

test('P2-1: a present unparseable Codex window makes the probe unreadable and refuses lending', async () => {
  for (const bad of [
    {used_percent: 105, limit_window_seconds: 18000, reset_after_seconds: 3600},
    {used_percent: 'bad', limit_window_seconds: 18000, reset_after_seconds: 3600},
    {used_percent: 12, limit_window_seconds: 18000},
    {used_percent: 12, limit_window_seconds: 'bad', reset_after_seconds: 3600},
    false,
  ]) {
    const reply = JSON.parse(usageLine());
    reply.body.rate_limit.secondary_window = bad;
    const probe = createLendingProbe({runGuest: async () => ({exitCode: 0, stdout: JSON.stringify(reply) + '\n'}),
      now: () => NOW});
    const result = await probe.probe('codex');
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'unreadable');
    const obs = await createRealPace50Source({readings: async () => ({
      refresh_succeeded: result.ok, windows: result.readings, probe: result,
    })}).observe({provider: 'codex'});
    assert.equal(paceInputFromObservation(obs, {now: NOW, context}).refuse, 'refresh_failed');
  }
});

test('a free plan refuses on funding even with a measurement', async () => {
  for (const providerPlan of ['free', 'unknown']) {
    const obs = await sourceFor(await probeFact(usageLine({plan: providerPlan})), undefined, measured())
      .observe({provider: 'codex', model: 'gpt-6-sol', plan: 'pro', now: NOW});
    assert.equal(obs.funding.subscription_only, 'unknown');
    assert.equal(paceInputFromObservation(obs, {now: NOW, context}).refuse, 'funding_unknown');
  }
});
