import './helpers/no-browser.mjs';
import {mkdtempSync, rmSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingReadings} from '../lib/v1/lending-probe.mjs';
import {usableAdmissionEvidence} from '../lib/v1/lender-pace50.mjs';
import {observationProofFailures} from '../lib/v1/lending-pace50-source.mjs';

// Behavior 1: a usage reading deferred because the previous same-name meter sandbox is still
// being removed (`deferral_cause: 'target_cleanup'`) gets one bounded retry before any stop.
// Hermetic: a deterministic clock, a real ledger in a temp dir, and a probe double. No sandbox,
// no network and no provider quota is touched.

const T = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3_600_000;
const MICRO = 1_000_000;

const CLEANUP = {ok: false, reason: 'probe_deferred', deferral_cause: 'target_cleanup'};

// A reading a successful retry would return: an idle five-hour window at 0%, weekly at 74%.
const freshReadings = [{window_id: 'five_hour', window_minutes: 300, used_pct: 0, resets_at: T + 4 * HOUR,
  observed_at: T, state: 'open', source: 'probe'},
{window_id: 'seven_day', window_minutes: 10080, used_pct: 74, resets_at: T + 4 * 24 * HOUR,
  observed_at: T, state: 'open', source: 'probe'}];

// The probe seam the readings function uses, with the sandbox start replaced by a scripted answer.
function probeDouble(ledger, outcomes) {
  const probe = {calls: 0,
    inFlight: () => false,
    due: () => true,
    retryAt: () => null,
    lastResult: () => null,
    successfulResult: () => null,
    latestAttempt: () => null,
    funding: () => ({subscription_only: 'proven'}),
    evidenceGeneration: () => 1,
    async probe() {
      const outcome = outcomes[Math.min(probe.calls, outcomes.length - 1)];
      probe.calls += 1;
      if (outcome.ok) ledger.recordReadings('claude', outcome.readings);
      return outcome;
    }};
  return probe;
}

function readingsFor(t, outcomes) {
  // The ledger file stays inside this checkout and is removed with the test.
  const directory = mkdtempSync(join(new URL('.', import.meta.url).pathname, '.acc-s1-cleanup-retry-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const ledger = createLendingLedger({file: join(directory, 'ledger.json'), now: () => T});
  const probe = probeDouble(ledger, outcomes);
  return {ledger, probe, readings: createLendingReadings({ledger, probe, plans: () => ({claude: 'max'}),
    jobRunning: () => false, now: () => T})};
}

// The observation the re-check judges: the job's launch reading, with the newest attempt's outcome.
function launchObservation({observedAt, rate = 0, attempt = {outcome: 'deferred', reason: 'probe_deferred'}}) {
  const resource = {id: 'five_hour', kind: 'short', instance: `five_hour@${observedAt + 4 * HOUR}`, state: 'open',
    anchor_at: observedAt - HOUR, resets_at: observedAt + 4 * HOUR, duration_ms: 5 * HOUR, observed_at: observedAt,
    used_micro: 0, owner_used_micro: 0, uncertainty_micro: MICRO, kappa_micro: null, kappa_lower_micro: null,
    conversion: 'native_window', origin: 'owner', ...(rate === undefined ? {} : {max_rate_pct_per_hour: rate})};
  return {refresh_succeeded: true, refresh_outcome: 'completed', complete: true, epoch: `five_hour@${observedAt + 4 * HOUR}`,
    account_week_id: 'acct:weekly:1', weekly_resource_id: 'seven_day',
    identity: {verified: true, account_id: 'acct'}, account_plan: {plan: 'max'}, resources: [resource],
    funding: {subscription_only: 'proven'}, executor: {single_executor: 'proven'},
    latest_attempt: attempt, stop_bound_ms: 60_000, uncertainty_ms: 0, evidence_generation: 1,
    stop: {bounded_execution: 'proven', proven_until: T + HOUR}};
}

test('a target_cleanup deferral gets one retry and the retry reading is the one returned', async t => {
  const {probe, readings} = readingsFor(t, [CLEANUP, {ok: true, probe: {reason: null}, readings: freshReadings}]);
  const value = await readings('claude', {forceRefresh: true});
  // Today the first deferral is returned unchanged after a single probe call, so this fails on the
  // missing retry: the caller sees `refresh_outcome: 'deferred'` with no window and calls it a stop.
  assert.equal(probe.calls, 2, 'the deferred reading is retried once');
  assert.notEqual(value.refresh_outcome, 'deferred');
  assert.deepEqual((value.windows ?? []).map(w => w.window_id), ['five_hour', 'seven_day']);
  assert.equal(value.read_at, T, 'the retry records the fresh reading');
});

test('the retry is bounded: a second target_cleanup deferral ends in a deferral, not a loop', async t => {
  const {probe, readings} = readingsFor(t, [CLEANUP, CLEANUP, {ok: true, readings: freshReadings}]);
  const value = await readings('claude', {forceRefresh: true});
  // Today a single probe call happens, so the count assertion fails first; the boundedness this test
  // protects is that the retry is one attempt, never a third.
  assert.equal(probe.calls, 2, 'exactly one retry, however the retry ends');
  assert.equal(value.refresh_outcome, 'deferred');
  assert.equal(value.probe.deferral_cause, 'target_cleanup');
});

test('a retry that also defers still stops a job whose reading is too old for its headroom', () => {
  // Ten minutes at the cold-start reserve (20 pts/h) is more than the headroom an idle window has.
  const observation = launchObservation({observedAt: T - 6 * HOUR});
  assert.deepEqual(observationProofFailures(observation), [], 'the fixture reaches the admission branch');
  const out = usableAdmissionEvidence(observation, {wall_ms: 300_000, stop_ms: 60_000, uncertainty_ms: 0},
    T, null, {headroom: true});
  // A measured 0% rate is not a bound, so a reading that is old and still deferred after the retry is priced at the default
  // rate. Frozen change (docs/foundation-1113/SPEC.md section 3): the stop is no longer named 'refresh_failed', because a
  // deferred refresh is an observation and adds no hold. The age reserve still exceeds the headroom, so the quantitative
  // admission check refuses with 'budget_too_small' (lender-pace50.mjs usableAdmissionEvidence).
  assert.equal(out, 'budget_too_small', 'the job still stops when the retry also defers and the reading is old');
});

test('the re-check after a successful retry admits the job instead of stopping it', () => {
  // A re-check after a retry that succeeded judges a good attempt against the fresh saving.
  const observation = launchObservation({observedAt: T, attempt: {outcome: 'good', reason: null}});
  assert.deepEqual(observationProofFailures(observation), []);
  assert.equal(usableAdmissionEvidence(observation, {wall_ms: 300_000, stop_ms: 60_000, uncertainty_ms: 0},
    T, null, {headroom: true}), null, 'the job is not stopped after a successful retry');
});
