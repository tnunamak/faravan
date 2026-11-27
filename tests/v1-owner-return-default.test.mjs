import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// Explicit owner-return events still stop work; the app's opt-in timer controls when activity requests a stop.
const HAIKU = 'claude-haiku-5-5';
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};

test('with stop-on-return enabled, an owner return stops admissions and asks a live attempt to cease', {timeout: 60000}, async t => {
  const policy = normalizeLendingPolicy({stopOnReturn:true,providerConsent: {claude: true}, accountPlans: {claude: 'max20'}});
  assert.equal(policy.stopOnReturn, true, 'owners can opt in to reclaim a lent job when they return');
  const directory = fs.mkdtempSync(join(tmpdir(), 'owner-return-default-'));
  const source = createSyntheticPace50Source({start: NOW});
  const objectiveInputFor = source.objectiveInputFor.bind(source);
  source.objectiveInputFor = args => {
    const input = objectiveInputFor(args);
    input.job.worstCallUsdMicro = Math.round(claudeCallHeadroomUsd(args.request.model) * 1_000_000);
    return input;
  };
  const pace = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK, source});
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  const admitted = await pace.candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: true});
  assert.equal(admitted.ok, true, 'a job is admitted before the owner returns');
  await pace.candidate.started('attempt-1', {ok: true});
  const stops = [];
  pace.candidate.registry.bind('attempt-1', {stop: reason => stops.push(reason)});

  const returned = await pace.adapter.deliver({type: 'owner_return', event_id: 'owner-return-1', at: NOW + 1000});
  assert.equal(returned.applied, true, 'the owner return is applied');
  assert.deepEqual(stops, ['owner_return'], 'the live attempt is asked to cease, once, for the owner return');
  const attempt = pace.adapter.state().attempts.find(a => a.id === 'attempt-1');
  assert.equal(attempt.process_state, 'cessation_requested');
  assert.equal(pace.adapter.state().owner_present, true);

  const next = await pace.candidate.reserve({attemptId: 'attempt-2', jobId: 'job-2', provider: 'claude', model: HAIKU, job,
    automatic: true, ownerAbsent: false});
  assert.equal(next.ok, false, 'no new admission while the owner is here');
  assert.equal(next.policyReason, 'adapter_frozen', 'the owner return stops admissions');
  assert.deepEqual(stops, ['owner_return'], 'a refused admission asks nothing more to stop');
});
