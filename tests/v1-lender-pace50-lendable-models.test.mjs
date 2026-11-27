import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate, lendableModelsFor, minimumMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

// Lead decision: remove the Haiku-only volume allocation. The objective sizes each model's chunk from spare capacity after that model's worst-call headroom.
const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + 3600e3).toISOString()};

test('priced Claude models use objective-sized chunks with model-specific call headroom', {timeout: 30000}, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'lendable-models-'));
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
  const lendable = lendableModelsFor('claude');
  assert.ok(lendable.includes(HAIKU));
  assert.ok(lendable.includes(SONNET));
  const granted = await pace.candidate.reserve({attemptId: 'attempt-sonnet', jobId: 'job-sonnet', provider: 'claude', model: SONNET, job,
    automatic: true, ownerAbsent: true});
  assert.equal(granted.ok, true, JSON.stringify(granted));
  const decision = pace.candidate.decisionFor('claude').objective;
  assert.equal(granted.maxBudgetUsd, decision.nativeMaxBudgetUsd);
  assert.ok(granted.maxBudgetUsd + claudeCallHeadroomUsd(SONNET) <= decision.maximumExposureUsd + 1e-9);
});

test('a model above the owner cap is refused while models within the cap remain lendable', {timeout: 30000}, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'lendable-model-cap-'));
  const source = createSyntheticPace50Source({start: NOW});
  const objectiveInputFor = source.objectiveInputFor.bind(source);
  source.objectiveInputFor = args => {
    const input = objectiveInputFor(args);
    input.job.worstCallUsdMicro = Math.ceil(claudeCallHeadroomUsd(args.request.model) * 1_000_000);
    return input;
  };
  const ownerSettings = {limit: () => ({state: 'set', maxJobUsd: 4})};
  const pace = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK, source, ownerSettings});
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  const opus = lendableModelsFor('claude').find(model => model.includes('opus') && minimumMaxJobUsdForModel(model) > 4);
  const affordable = lendableModelsFor('claude').filter(model => minimumMaxJobUsdForModel(model) <= 4);
  assert.ok(opus, 'the priced model list includes Opus above the $4 default cap');
  assert.ok(affordable.length > 0, 'at least one priced model fits the default cap');
  assert.deepEqual(lendableModelsFor('claude', {ownerCapUsd: 4}), affordable);

  const blocked = await pace.candidate.reserve({attemptId: 'attempt-opus-over-cap', jobId: 'job-opus-over-cap', provider: 'claude',
    model: opus, job, automatic: true, ownerAbsent: true});
  assert.equal(blocked.ok, false);
  assert.equal(blocked.policyReason, 'budget_too_small');
  assert.equal(pace.adapter.state().attempts.length, 0, 'the over-cap model creates no reservation');

  const allowed = await pace.candidate.reserve({attemptId: 'attempt-model-under-cap', jobId: 'job-model-under-cap', provider: 'claude',
    model: affordable[0], job, automatic: true, ownerAbsent: true});
  assert.equal(allowed.ok, true, JSON.stringify(allowed));
});

test('a fractional-cent cap above the micro-dollar call bound remains lendable', {timeout: 30000}, async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'lendable-model-fractional-cap-'));
  const source = createSyntheticPace50Source({start: NOW});
  const objectiveInputFor = source.objectiveInputFor.bind(source);
  source.objectiveInputFor = args => {
    const input = objectiveInputFor(args);
    input.job.worstCallUsdMicro = Math.ceil(claudeCallHeadroomUsd(args.request.model) * 1_000_000);
    return input;
  };
  const ownerCapUsd = 1.325;
  const ownerSettings = {limit: () => ({state: 'set', maxJobUsd: ownerCapUsd})};
  const pace = createPace50Candidate({directory, now: () => NOW, account: ACCOUNT, account_week_id: WEEK, source, ownerSettings});
  t.after(async () => {
    await pace.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });

  assert.equal(minimumMaxJobUsdForModel(HAIKU), 1.33, 'the control rounds the strict engine bound to cents');
  assert.ok(lendableModelsFor('claude', {ownerCapUsd}).includes(HAIKU), 'the engine accepts any cap above the actual $1.32 bound');
  const grant = await pace.candidate.reserve({attemptId: 'attempt-fractional-cap', jobId: 'job-fractional-cap',
    provider: 'claude', model: HAIKU, job, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.equal(grant.maxBudgetUsd, 0.005);
});
