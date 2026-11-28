import './helpers/no-browser.mjs';

import test from 'node:test';
import assert from 'node:assert/strict';

import {lagBoundsFor, PROVIDER_LAG_MS, BURN_RATE_MARGIN, COLD_START_POINTS_PER_HOUR} from '../lib/v1/lending-rule-defaults.mjs';

// The fluid rule inside the real lender app's admission path (startup option lendingRule === 'fluid').
// Every number is a synthetic test input. The registry, rounding, native-cost, ledger and owner-trace attestations
// are trusted startup inputs for this test only: the production server has no complete quota registry and no
// same-account ledger identity yet. The owner trace is a synthetic 2 points/hour probe, not provider evidence.
const MICRO = 1_000_000, H = 3_600_000;

test('lag and rate defaults: 1.5 times the highest hourly burn in seven days, cold start with no usable interval', () => {
  const now = 1000 * H;
  const rows = [
    {window_id: 'seven_day', trace: [[now - 2 * H, 0], [now - H, 2], [now - H / 2, 2.5]]},
    {window_id: 'seven_day', trace: [[now - 200 * H, 0], [now - 199 * H, 50]]}, // outside seven days: ignored
  ];
  const bounds = lagBoundsFor({windows: [{id: 'seven_day'}, {id: 'five_hour'}], rows, now});
  assert.equal(bounds.providerLagMs.seven_day, PROVIDER_LAG_MS);
  assert.equal(bounds.maxPointsPerHour.seven_day, BURN_RATE_MARGIN * 2);
  assert.equal(bounds.maxPointsPerHour.five_hour, COLD_START_POINTS_PER_HOUR);
  assert.equal(bounds.providerLagProvenance, 'lead-chosen meter lag allowance');
  assert.equal(bounds.rateProvenance, 'cold-start default (lead-chosen)');
  assert.equal(lagBoundsFor({windows: [{id: 'seven_day'}], rows, now}).rateProvenance,
    'estimated from owner history x1.5 (lead-chosen)');
});

// Starts a lender with the given rule setting and an explicit 100% cap so the $20 job exercises the rule.

// A light owner: 10 points used, three hours before the weekly reset.

// A heavy owner: 80 points used by hour 42 of the 168-hour week (126 hours remain).

// Production evidence: no lendingRule option and no attestation. The registry, snapshot, rounding, rate bounds,
// owner history and native cost all come from lending-rule-defaults.mjs and the app's own stores.

// The fluid rule is the Automatic strategy. An owner's Fixed share choice keeps its own numbers under the default.

test('production attestations: live rate rows, cold-start floor, registry from the live roster, supported history only', async () => {
  const {liveRateRows, registryFor, ruleHistoryFor, nativeCostBounds} = await import('../lib/v1/lending-rule-defaults.mjs');
  const now = 1000 * H;
  const windows = [{id: 'seven_day', anchor_at: now - 100 * H, resets_at: now + 68 * H, duration_ms: 168 * H, used_micro: 40 * MICRO, kappa_micro: 370000},
    {id: 'five_hour', anchor_at: now - H, resets_at: now + 4 * H, duration_ms: 5 * H, used_micro: 30 * MICRO, kappa_micro: 2_000_000}];
  const live = liveRateRows(windows, now);
  assert.deepEqual(live.map(r => r.trace), [[[now - 100 * H, 0], [now, 40]], [[now - H, 0], [now, 30]]]);
  // No owner history: the five-hour window's live burn (30/h) x1.5 beats the 20/h floor; the weekly gets the floor.
  const bounds = lagBoundsFor({windows, rows: [], liveRows: live, now});
  assert.equal(bounds.maxPointsPerHour.seven_day, COLD_START_POINTS_PER_HOUR);
  assert.equal(bounds.maxPointsPerHour.five_hour, 45);
  const registry = registryFor({provider: 'claude', model: 'claude-haiku-5-5', windows});
  assert.equal(registry.complete, true);
  assert.deepEqual(registry.limits.map(l => l.weights.byModel['claude-haiku-5-5']), [0.37, 2]);
  assert.equal(registryFor({provider: 'claude', model: 'claude-haiku-5-5', windows: [{...windows[0], id: 'mystery'}]}), null);
  assert.equal(registryFor({provider: 'claude', model: 'claude-haiku-5-5', windows: [{...windows[0], kappa_micro: 0}]}), null);
  assert.deepEqual(nativeCostBounds(2_890_000), {unit: 'usd', lower: 0, upper: 2.89});
  const good = {window_id: 'seven_day', start_at: now - 300 * H, resets_at: now - 132 * H, length_ms: 168 * H, complete: true, censored: false,
    source: 'import', rounding_points: 0, metadata: {measurement: 'exact'}, trace: [[now - 300 * H, 0], [now - 132 * H, 10]]};
  const censored = {...good, censored: true, trace: [], metadata: {measurement: null, excluded_reason: 'account_week_censored'}};
  const {history, rateHistory} = ruleHistoryFor([good, censored], now);
  assert.deepEqual(history, [good]);
  assert.deepEqual(rateHistory, [good]);
});

// The window memory inside the real lender app (production evidence: no attested registry). The synthetic source
// stops reporting the five-hour window after the first reply; the lender's clock is moved by hand.
