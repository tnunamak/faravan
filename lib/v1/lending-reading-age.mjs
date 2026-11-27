import {BURN_RATE_MARGIN, COLD_START_POINTS_PER_HOUR} from './lending-rule-defaults.mjs';

const MICRO = 1_000_000;

// Reuse the rule's existing history multiplier and cold-start estimate (20 points/hour).
// This is a plausible spend estimate, not a guarantee of a future rate bound.
export function readingSpendRate(resource) {
  const rate = resource?.max_rate_pct_per_hour;
  return Number.isFinite(rate) && rate > 0 ? rate * BURN_RATE_MARGIN : COLD_START_POINTS_PER_HOUR;
}
export const readingAgeReserve = (resource, now) => Math.ceil(Math.max(0, now - resource.observed_at) *
  readingSpendRate(resource) * MICRO / 3_600_000);
export const readingHeadroomMs = resource => Math.max(0, (100 * MICRO - resource.used_micro -
  (resource.uncertainty_micro ?? 0)) * 3_600_000 / (readingSpendRate(resource) * MICRO));
