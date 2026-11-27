import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {createLender} from '../lib/v1/lender.mjs';

// A Claude chunk's enforced cap is the admitted budget less one worst-case call. That call is priced at the model's largest
// context, in the tier that context reaches. The reservation returns that cap and its guard budget, and the lender passes both
// into the run, so the command the sandbox executes is bounded by what was admitted.
const HAIKU = 'claude-haiku-5-5';
const ACCOUNT = 'synthetic-account';
const WEEK = 'synthetic-week-1';
const NEAR = (actual, expected) => Math.abs(actual - expected) < 1e-5;
const job = requestedUsd => ({requirements: {limits: {wall_seconds: 300}}, expires_at: null, budget_v1: {max_list_usd: requestedUsd}});
const reserve = (pace, {model = HAIKU, requestedUsd = 4, attemptId = 'attempt-1'} = {}) => pace.reserve({attemptId, jobId: `job-${attemptId}`, provider: 'claude', model, job: job(requestedUsd),
  automatic: true, ownerAbsent: true});

function candidate(directory, {limit, now, chunkCandidates = null}) {
  const ownerSettings = createOwnerSettings({directory: join(directory, 'owner-settings')});
  if (limit !== null) ownerSettings.set({by: 'owner', reason: 'test limit', now, maxJobUsd: limit});
  const source = createSyntheticPace50Source({start: now});
  if (chunkCandidates) {
    const build = source.objectiveInputFor;
    source.objectiveInputFor = args => {
      const input = build(args);
      input.job.chunkCandidates = chunkCandidates;
      return input;
    };
  }
  return createPace50Candidate({directory, now: () => now, account: ACCOUNT, account_week_id: WEEK,
    source, ownerSettings});
}

test('the per-call headroom prices the largest context in the tier that context reaches', () => {
  // Haiku 5.5's largest context is 1M tokens, above the 100k threshold, so each input token is priced at the higher tier:
  // 1,000,000 x $1.00/M cache write, plus 128,000 x $2.50/M output.
  assert.ok(NEAR(claudeCallHeadroomUsd(HAIKU), 1.32), `haiku 5.5 headroom ${claudeCallHeadroomUsd(HAIKU)}`);
  // Haiku 4.5 has no higher tier: 200,000 x $2.00/M cache write, plus 128,000 x $5.00/M output.
  assert.ok(NEAR(claudeCallHeadroomUsd('claude-haiku-4-5'), 1.04), `haiku 4.5 headroom ${claudeCallHeadroomUsd('claude-haiku-4-5')}`);
});

test('unequal signed and owner caps both bound gross exposure and the native spend budget', {timeout: 30000}, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cap-admitted-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const now = Date.parse('2026-10-23T06:40:00Z');
  const chunks = [{id:'owner-cap',usdMicro:1_500_000,friendValue:100},{id:'above-owner-cap',usdMicro:2_000_000,friendValue:200}];
  const opened = candidate(join(dir, 'owner-lower'), {limit: 1.5, now, chunkCandidates:chunks});
  const grant = await reserve(opened.candidate);
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.deepEqual(grant.lendingBudget, {agent: 'claude', budget: {unit: 'claude_usd', limit: 0.18}}, 'the guard budget excludes the separately reserved worst-call headroom');
  assert.ok(NEAR(grant.maxBudgetUsd, 0.18), `the cap is 1.50 less 1.32: ${grant.maxBudgetUsd}`);
  assert.equal(grant.maxBudgetUsd, (1_500_000 - 1_320_000) / 1_000_000, 'integer micro-dollar headroom is subtracted exactly once');
  assert.equal(opened.adapter.state().attempts[0].resources.reduce((sum, row) => sum + row.initial_micro, 0), 375_000,
    'the $1.50 owner cap controls the $4 signed request before native call headroom is removed');
  await opened.adapter.close();

  const reverse = candidate(join(dir, 'request-lower'), {limit: 4, now, chunkCandidates:chunks});
  const requestBound = await reserve(reverse.candidate, {requestedUsd:1.5, attemptId:'request-lower'});
  assert.equal(requestBound.ok, true, JSON.stringify(requestBound));
  assert.equal(requestBound.maxBudgetUsd, 0.18, 'the $1.50 signed request controls when the owner cap is $4');
  assert.deepEqual(requestBound.lendingBudget, {agent: 'claude', budget: {unit: 'claude_usd', limit: 0.18}});
  assert.equal(reverse.adapter.state().attempts[0].resources.reduce((sum, row) => sum + row.initial_micro, 0), 375_000,
    'gross reservation is limited by the signed request before subtracting headroom');
  await reverse.adapter.close();
});

test('a limit that cannot hold one worst-case call is refused before admission, and nothing is recorded', {timeout: 30000}, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cap-small-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const opened = candidate(dir, {limit: 0.3, now: Date.parse('2026-10-23T06:40:00Z')});
  const grant = await reserve(opened.candidate);
  assert.equal(grant.ok, false);
  assert.equal(grant.reason, 'quota_reserve');
  assert.equal(grant.policyReason, 'budget_too_small');
  assert.equal(opened.adapter.state().attempts.length, 0, 'the refused chunk was never admitted, so nothing is held');
  await opened.adapter.close();
});

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: (event) => { f.events.push(event); }});
  const running = lender.start(controller.signal);
  let failure;
  const settled = Promise.resolve(running).catch((error) => { failure = error; });
  f.stop = async () => {
    controller.abort();
    await settled;
    if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure;
  };
}
const settingsOn = () => ({intent: 'on', limits: {lendingPolicy: normalizeLendingPolicy({providerConsent: {claude: true}})}});

test('an admitted Claude job runs with the admitted cap in its command and the admitted guard budget, through the lender', {timeout: 90000}, async (t) => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, harness: 'claude-code-subscription'});
  f.adapters[0].run = {model: HAIKU}; // the lender prices the chunk by the model the adapter runs
  f.policy.userActive = async () => false;
  const directory = join(f.root, 'pace50');
  const ownerSettings = createOwnerSettings({directory: join(directory, 'owner-settings')});
  ownerSettings.set({by: 'owner', reason: 'test limit', now: f.clock.now(), maxJobUsd: 1.5});
  const runtime = createLendingRuntime({directory, settings: settingsOn, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: ACCOUNT, account_week_id: WEEK, source: createSyntheticPace50Source({start: f.clock.now()}), ownerSettings}});
  const starts = [];
  const start = f.backend.start.bind(f.backend);
  f.backend.start = (handle, opts) => {
    starts.push({command: String(handle._entrypoint), lendingBudget: opts?.lendingBudget ?? null});
    return start(handle, opts);
  };
  f.policy.lendingRuntime = runtime;
  launch(f);
  await until(() => f.count('/complete') === 1, 'signed completion through the candidate path');
  await f.stop();
  const claude = starts.find((s) => /--max-budget-usd/.test(s.command));
  assert.ok(claude, `the Claude command carries the cap: ${starts.map((s) => s.command.slice(0, 80)).join(' | ')}`);
  const cap = Number(/--max-budget-usd'?\s+'?([0-9.]+)/.exec(claude.command)[1]);
  assert.ok(NEAR(cap, 0.18), `the command's cap is the admitted cap: ${cap}`);
  assert.deepEqual(claude.lendingBudget, {agent: 'claude', budget: {unit: 'claude_usd', limit: 0.18}}, 'the guard receives the admitted budget');
  await runtime.close();
});

test('a codex chunk carries its guard budget in credits, weighted by its model; an unpriced codex model is refused before admission', {timeout: 30000}, async (t) => {
  const dir = fs.mkdtempSync(join(tmpdir(), 'cap-codex-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const opened = candidate(dir, {limit: null, now: Date.parse('2026-10-23T06:40:00Z')});
  const codexJob = {requirements: {limits: {wall_seconds: 300}}, expires_at: null};
  const grant = await opened.candidate.reserve({attemptId: 'attempt-codex', jobId: 'job-codex', provider: 'codex', model: 'gpt-6-sol',
    job: codexJob, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.equal(grant.lendingBudget.agent, 'codex');
  assert.equal(grant.lendingBudget.budget.unit, 'codex_credits');
  // M1 (money-path fixes 1030): the cap converts at the costliest context tier, so a long-context call cannot overspend it.
  assert.equal(grant.lendingBudget.budget.limit, 33.5, 'the default $4 owner cap is converted at the tier-safe credit rate, less call headroom');
  assert.deepEqual(Object.keys(grant.lendingBudget.budget.weights).sort(), ['cached_input', 'input', 'output'], 'the guard weighs each token class');
  assert.equal(grant.maxBudgetUsd, undefined, 'codex is bounded in credits, not a USD cap');
  const refused = await opened.candidate.reserve({attemptId: 'attempt-codex-2', jobId: 'job-codex-2', provider: 'codex', model: 'example-model',
    job: codexJob, automatic: true, ownerAbsent: true});
  assert.equal(refused.ok, false);
  assert.equal(refused.policyReason, 'model_unpriced', 'an unpriced codex model cannot be enforced, so nothing is admitted');
  assert.equal(opened.adapter.state().attempts.length, 1, 'only the priced chunk was admitted');
  await opened.adapter.close();
});
