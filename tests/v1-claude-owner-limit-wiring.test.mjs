import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

const NOW = Date.UTC(2026, 9, 23, 10, 0, 0);
const MICRO = 1_000_000;
const JOB = {requirements: {limits: {wall_seconds: 240}}, expires_at: null, budget_v1: {max_list_usd: 4}};
const reserveClaude = (candidate, attemptId) => candidate.reserve({attemptId, jobId: `job-${attemptId}`, provider: 'claude',
  model: 'claude-haiku-5-5', job: JOB, automatic: true, ownerAbsent: true});

test('the runtime reads the saved per-job total-spend cap and applies it before the Claude native cap', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'owner-limit-wiring-'));
  let runtime;
  try {
    const ownerSettings = createOwnerSettings({directory: join(directory, 'owner-settings')});
    const source = createSyntheticPace50Source({start: NOW});
    const build = source.objectiveInputFor;
    source.objectiveInputFor = args => {
      const input = build(args);
      input.job.chunkCandidates = [{id: 'owner-sized-checkpoint', usdMicro: 1_500_000, friendValue: 100}];
      return input;
    };
    runtime = createLendingRuntime({directory, backend: {}, settings: () => ({limits: {lendingPolicy: {
      providerConsent: {claude: true},
    }}}), now: () => NOW,
      presence: async () => false, lastActiveAt: () => null, selfKey: () => 'self', liveAttemptIds: () => [],
      pace50: {source, account: 'synthetic-account', account_week_id: 'synthetic-week-1', ownerSettings}});

    ownerSettings.set({by: 'owner', reason: 'cap below worst call', now: NOW, maxJobUsd: 1});
    const tooSmall = await reserveClaude(runtime.candidate, 'a-small');
    assert.equal(tooSmall.ok, false);
    assert.equal(tooSmall.policyReason, 'budget_too_small');
    assert.equal(runtime.pace50.state().attempts.length, 0);

    // Same runtime and $4 request: the saved $1.50 owner cap bounds total spend,
    // and the native cap leaves one $1.32 worst-call headroom.
    ownerSettings.set({by: 'owner', reason: 'usable total-spend cap', now: NOW, maxJobUsd: 1.5});
    const usable = await reserveClaude(runtime.candidate, 'a-usable');
    assert.equal(usable.ok, true, JSON.stringify(usable));
    assert.equal(usable.maxBudgetUsd, 0.18);
    assert.equal(runtime.candidate.decisionFor('claude').objective.maximumExposureUsd, 1.5);
    assert.equal(runtime.candidate.decisionFor('claude').objective.nativeMaxBudgetUsd, 0.18);
    assert.equal(runtime.pace50.state().attempts.length, 1);
    assert.equal(runtime.pace50.state().attempts[0].resources.reduce((sum, row) => sum + row.initial_micro, 0), 375_000,
      'the $1.50 total reservation converts to 0.075 weekly points and 0.30 short-window points');
    assert.equal(usable.lendingBudget.budget.limit, 0.18);
  } finally {
    await runtime?.close();
    rmSync(directory, {recursive: true, force: true});
  }
});
