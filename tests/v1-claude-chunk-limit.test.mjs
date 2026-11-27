import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chunkLimitUsdMicro} from '../lib/v1/chunk-limit.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

const NOW = Date.parse('2026-10-23T06:40:00Z');
const MICRO = 1_000_000;

test('the objective size is lowered by the owner total-spend cap and borrower request', () => {
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 1_500_000}), 1_500_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000}), 2_500_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 0}), 0,
    'a zero total-spend cap allows no exposure');
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 2_000_000,
    jobLimitUsdMicro: 700_000}), 700_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, ownerLimitUsdMicro: 2_000_000,
    jobLimitUsdMicro: 5_000_000}), 2_000_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, jobLimitUsdMicro: 1_500_000}), 1_500_000);
  assert.equal(chunkLimitUsdMicro({sizeUsdMicro: 2_500_000, jobLimitUsdMicro: 9_000_000}), 2_500_000);
});

test('the durable objective sizes gross exposure from spare and sends native cap minus one worst call', async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'chunk-size-'));
  const source = createSyntheticPace50Source({start: NOW, kappa: {weekly: 1_000_000, short: 1_000_000}});
  const build = source.objectiveInputFor;
  source.objectiveInputFor = args => {
    const input = build(args);
    // This fixture supplies a separate value for a $2 checkpoint inside the $4 request.
    input.job.chunkCandidates = [{id: 'two-dollar-checkpoint', usdMicro: 2 * MICRO, friendValue: 100}];
    return input;
  };
  const ownerSettings = {limit: () => ({state: 'set', maxJobUsd: 2})};
  const {candidate, adapter} = createPace50Candidate({directory: dir, now: () => NOW, account: 'synthetic-account',
    account_week_id: 'synthetic-week-1', source, ownerSettings});
  t.after(async () => {
    await adapter.close();
    fs.rmSync(dir, {recursive: true, force: true});
  });

  const grant = await candidate.reserve({attemptId: 'attempt-size', jobId: 'job-size', provider: 'claude',
    model: 'claude-haiku-5-5', job: {requirements: {limits: {wall_seconds: 240}}, expires_at: null,
      budget_v1: {max_list_usd: 4}}, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const objective = candidate.decisionFor('claude').objective;
  const headroom = claudeCallHeadroomUsd('claude-haiku-5-5');
  assert.equal(headroom, 1.32);
  assert.equal(objective.maximumExposureUsd, 2, 'the owner cap bounds total exposure for the objective-selected chunk');
  assert.equal(objective.nativeMaxBudgetUsd, 680_000 / MICRO);
  assert.equal(grant.maxBudgetUsd, 680_000 / MICRO);
  assert.equal(grant.lendingBudget.budget.limit, 680_000 / MICRO);
});
