import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {readingSpendRate} from '../lib/v1/lending-reading-age.mjs';
import {COLD_START_POINTS_PER_HOUR} from '../lib/v1/lending-rule-defaults.mjs';

// Behavior 2: a 5-hour window measured at 0% (a measured rate of 0) is not treated as having no
// rate. The distinction that matters is "no rate known" (absent or non-finite) versus "measured 0".
//
// Hermetic: hand-built observations, a fixed clock, no sandbox, network or quota.

const T = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3_600_000;
const MICRO = 1_000_000;

// An idle five-hour window: nothing used, measured at 0% over the account's recent use.
const resource = (over = {}) => ({id: 'five_hour', kind: 'short', instance: `five_hour@${T + 4 * HOUR}`, state: 'open',
  anchor_at: T - HOUR, resets_at: T + 4 * HOUR, duration_ms: 5 * HOUR, observed_at: T - 15_000,
  used_micro: 0, owner_used_micro: 0, uncertainty_micro: MICRO, kappa_micro: null, kappa_lower_micro: null,
  conversion: 'native_window', origin: 'owner', max_rate_pct_per_hour: 0, ...over});

// The red test for a measured 0 rate (meter deferral must not become refresh_failed) is
// tests/usable-admission-evidence.redcheck.test.mjs in maple-red-claude-1110; not repeated here.

test('a measured zero rate still prices age at the cold-start reserve', () => {
  // The safety side of "measured 0 is a rate": it never becomes a free window. Age is still charged
  // at the cold-start estimate, which is what stops a stale reading later.
  assert.equal(readingSpendRate(resource()), COLD_START_POINTS_PER_HOUR);
  assert.equal(readingSpendRate(resource({max_rate_pct_per_hour: 12})), 12 * 1.5,
    'a positive measured rate still wins over the reserve');
});
