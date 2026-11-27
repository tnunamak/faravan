import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate, currentFor, usableAdmissionEvidence} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

const MODEL = 'claude-haiku-5-5';
const JOB = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};

// Frozen change (docs/foundation-1113/SPEC.md section 3, "No stale/missing usage ... may add a hard hold"): a transient failed
// refresh is an observation, not an admission veto. The first assertion of this test used to demand 'refresh_failed'; it now
// demands no hold. The reserve for the stale reading is priced by the accounting below, not refused.
test('a transient failed refresh is an observation: it adds no admission hold, the old reading is priced instead', async () => {
  const source = createSyntheticPace50Source({start: NOW - 5 * 60_000,
    used: {weekly: 10 * MICRO, short: 10 * MICRO}});
  const observation = await source.observe({provider: 'claude', now: NOW - 5 * 60_000});
  const failedRefresh = {...observation, latest_attempt: {outcome: 'failed', reason: 'rate_limited'}};
  const actualOwnerUseMicro = 90 * MICRO;
  assert.equal(currentFor(failedRefresh, NOW), true, 'the default-rate estimate leaves apparent headroom');
  assert.ok(100 * MICRO - actualOwnerUseMicro < 15 * MICRO,
    'a 15-point job would displace the owner when the current meter is at 90 points');
  const reason = usableAdmissionEvidence(failedRefresh, null, NOW);

  assert.equal(reason, null,
    'a failed refresh adds no hard hold; only an invalidating failure does');
});

test('a borrower zero-use report leaves converted exposure held until the provider meter accounts for it', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'zero-use-held-'));
  const clock = {at: NOW};
  const source = createSyntheticPace50Source({start: NOW,
    used: {weekly: 20 * MICRO, short: 40 * MICRO}, kappa: {weekly: MICRO, short: MICRO}});
  const pace = createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT,
    account_week_id: WEEK, source});
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  const grant = await pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude',
    model: MODEL, job: JOB, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  await pace.candidate.started('attempt-1', {ok: true});
  await pace.candidate.recordCleanup('attempt-1', {removed: true});
  await pace.candidate.finish({attemptId: 'attempt-1', provider: 'claude', model: MODEL,
    execution: {stdout: JSON.stringify({type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0,
      usage: {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}})}});

  const attempt = pace.adapter.state().attempts.find(row => row.id === 'attempt-1');
  assert.equal(attempt.hold_closed, false, 'borrower output alone cannot release the reservation');
  assert.ok(attempt.resources.every(resource => resource.held_micro > 0 && resource.released_micro === 0));
});
