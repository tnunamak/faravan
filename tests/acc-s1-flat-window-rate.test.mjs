import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {usableAdmissionEvidence} from '../lib/v1/lender-pace50.mjs';
import {observationProofFailures} from '../lib/v1/lending-pace50-source.mjs';
import {readingSpendRate} from '../lib/v1/lending-reading-age.mjs';
import {COLD_START_POINTS_PER_HOUR} from '../lib/v1/lending-rule-defaults.mjs';

// Behavior 2: a 5-hour window measured at 0% (a measured rate of 0) is not treated as having no
// rate. The distinction that matters is "no rate known" (absent or non-finite) versus "measured 0".
//
// Hermetic: hand-built observations, a fixed clock, no sandbox, network or quota.

const T = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3_600_000;
const MICRO = 1_000_000;
const DEFERRED = {outcome: 'deferred', reason: 'probe_deferred'};

// An idle five-hour window: nothing used, measured at 0% over the account's recent use.
const resource = (over = {}) => ({id: 'five_hour', kind: 'short', instance: `five_hour@${T + 4 * HOUR}`, state: 'open',
  anchor_at: T - HOUR, resets_at: T + 4 * HOUR, duration_ms: 5 * HOUR, observed_at: T - 15_000,
  used_micro: 0, owner_used_micro: 0, uncertainty_micro: MICRO, kappa_micro: null, kappa_lower_micro: null,
  conversion: 'native_window', origin: 'owner', max_rate_pct_per_hour: 0, ...over});

const observation = (over = {}) => ({refresh_succeeded: true, refresh_outcome: 'completed', complete: true,
  epoch: `five_hour@${T + 4 * HOUR}`, account_week_id: 'acct:weekly:1', weekly_resource_id: 'seven_day',
  identity: {verified: true, account_id: 'acct'}, account_plan: {plan: 'max'}, resources: [resource()],
  funding: {subscription_only: 'proven'}, executor: {single_executor: 'proven'}, latest_attempt: DEFERRED,
  stop_bound_ms: 60_000, uncertainty_ms: 0, evidence_generation: 1,
  stop: {bounded_execution: 'proven', proven_until: T + HOUR}, ...over});

const judge = (obs, options = {headroom: true}) => usableAdmissionEvidence(obs,
  {wall_ms: 300_000, stop_ms: 60_000, uncertainty_ms: 0}, T, null, options);

// The red test for a measured 0 rate (meter deferral must not become refresh_failed) is
// tests/usable-admission-evidence.redcheck.test.mjs in maple-red-claude-1110; not repeated here.

test('a rate that is not known still relies on the default rate, and is not a hold', () => {
  // Frozen change (docs/foundation-1113/SPEC.md section 3): an unknown rate used to stop a deferred reading with
  // 'refresh_failed'. A missing or deferred usage observation now adds no hard hold. What survives is that an unknown rate is
  // priced at the default rate (the next test), never treated as a free window.
  const obs = observation({resources: [resource({max_rate_pct_per_hour: undefined})]});
  assert.deepEqual(observationProofFailures(obs), []);
  assert.equal(judge(obs), null);
  assert.equal(judge(observation({resources: [resource({max_rate_pct_per_hour: null})]})), null);
  assert.equal(judge(observation({resources: [resource({max_rate_pct_per_hour: NaN})]})), null);
  for (const unknown of [undefined, null, NaN])
    assert.equal(readingSpendRate(resource({max_rate_pct_per_hour: unknown})), COLD_START_POINTS_PER_HOUR);
});

test('a measured zero rate still prices age at the cold-start reserve', () => {
  // The safety side of "measured 0 is a rate": it never becomes a free window. Age is still charged
  // at the cold-start estimate, which is what stops a stale reading later.
  assert.equal(readingSpendRate(resource()), COLD_START_POINTS_PER_HOUR);
  assert.equal(readingSpendRate(resource({max_rate_pct_per_hour: 12})), 12 * 1.5,
    'a positive measured rate still wins over the reserve');
});
