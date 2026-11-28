import './helpers/no-browser.mjs';
import {mkdtempSync, rmSync} from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {createLendingLedger} from '../lib/v1/lending-ledger.mjs';
import {createLendingReadings} from '../lib/v1/lending-probe.mjs';

// Behavior 1: a usage reading deferred because the previous same-name meter sandbox is still
// being removed (`deferral_cause: 'target_cleanup'`) gets one bounded retry before any stop.
// Hermetic: a deterministic clock, a real ledger in a temp dir, and a probe double. No sandbox,
// no network and no provider quota is touched.

const T = Date.parse('2026-11-01T12:00:00Z');
const HOUR = 3_600_000;

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
