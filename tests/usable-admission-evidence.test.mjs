import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {usableAdmissionEvidence} from '../lib/v1/lender-pace50.mjs';

const MICRO = 1_000_000;
test('a transient meter deferral adds no hold when the window rate is measured as zero', () => {
  const at = 1_000_000_000_000;
  const resource = {id: 'five_hour', instance: 'five_hour@x', state: 'open', anchor_at: at - 3_600_000,
    resets_at: at + 4 * 3_600_000, duration_ms: 5 * 3_600_000, observed_at: at - 15_000, used_micro: 0,
    owner_used_micro: 0, uncertainty_micro: MICRO, kappa_micro: null, conversion: 'native_window',
    max_rate_pct_per_hour: 0};
  const observation = {
    refresh_succeeded: true, refresh_outcome: 'completed', complete: true, epoch: 'e1', account_week_id: 'w1',
    weekly_resource_id: 'five_hour', funding: {subscription_only: 'proven'}, executor: {single_executor: 'proven'},
    identity: {verified: true, account_id: 'acct'}, account_plan: {plan: 'max'}, resources: [resource],
    latest_attempt: {outcome: 'deferred', reason: 'probe_deferred'}, stop_bound_ms: 1000, uncertainty_ms: 0,
    stop: {bounded_execution: 'proven', proven_until: at + 3_600_000},
  };
  const out = usableAdmissionEvidence(observation, {wall_ms: 60_000, stop_ms: 1000, uncertainty_ms: 0}, at, null, {headroom: true});
  // Frozen change (docs/foundation-1113/SPEC.md §3: no stale or missing usage may add a hard hold, and no age-only Stop): an old
  // reading under a transient deferral is priced at the cold rate by the next test, not refused here.
  assert.equal(out, null);
});

test('a measured 0% window prices an old reading at the 20 points per hour cold rate, which bounds unseen spend', async () => {
  const {readingAgeReserve} = await import('../lib/v1/lending-reading-age.mjs');
  const {currentFor} = await import('../lib/v1/lender-pace50.mjs');
  const at = 1_000_000_000_000;
  const hour = 3_600_000;
  const resource = used => ({id: 'five_hour', observed_at: at, used_micro: used * MICRO, uncertainty_micro: MICRO, max_rate_pct_per_hour: 0});
  const age = ms => readingAgeReserve(resource(0), at + ms) / MICRO;
  // Unseen spend is priced at 20 points/hour: 15 s is 0.0833 points, 15 min (the stop-proof age) is 5 points, 1 hour is 20.
  assert.equal(age(15_000).toFixed(4), '0.0833');
  assert.equal(age(15 * 60_000), 5);
  assert.equal(age(hour), 20);
  // A window already at 93 points with a 1 point uncertainty admits a reading up to 5 hours old only when 20 pts/h x age fits the headroom.
  const obs = used => ({resources: [resource(used)]});
  assert.equal(currentFor(obs(93), at + 15 * 60_000), true);   // 93 + 1 + 5 = 99
  assert.equal(currentFor(obs(93), at + 20 * 60_000), false);
  assert.equal(currentFor(obs(0), at + 4 * hour), true);       // 0 + 1 + 80
  assert.equal(currentFor(obs(0), at + 5 * hour), false);      // 0 + 1 + 100
});
