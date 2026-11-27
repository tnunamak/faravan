import './helpers/no-browser.mjs';
import {PROVIDER_PERCENT_UNCERTAINTY_MICRO} from '../lib/v1/quota-registry.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd, currentPriceCatalog, setLiveListPrices} from '../lib/v1/lending-meter.mjs';
import {startPriceRefresh} from '../lib/v1/lending-price-refresh.mjs';
import {createSyntheticPace50Source, SYNTHETIC_RESET} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

import {HAIKU, fixture, attemptJob, decision} from './helpers/objective-durable-fixture.mjs';

test('(a) a durable chunk records spend while preserving unresolved attribution', {timeout: 30000}, async t => {
  // The declared whole-point unit takes one point off each window's spare. The owner's reading is 9 here, not 10, so the weekly
  // spare is 90 points (100 - 9 - 1). One $3 chunk fits and stays unresolved after cleanup.
  const f = fixture(t, {used: {weekly: 9 * MICRO, short: 0}, kappa: {weekly: MICRO, short: MICRO},
    profile: {friendValue: 3, estimateUsdMicro: 3 * MICRO}});
  {
    const index = 0, id = String(index);
    const args = attemptJob(id, f.clock.at, {requestedUsd: 3});
    const quote = await f.candidate.preview({attemptId: args.attemptId, jobId: args.jobId, job: args.job,
      provider: 'claude', model: HAIKU, ownerAbsent: true});
    assert.equal(quote.admitted, true, `chunk ${id}: ${quote.reason}`);
    assert.equal(quote.objective.maximumExposureUsd, 3);
    assert.equal(quote.objective.nativeMaxBudgetUsd, 1.68);
    assert.deepEqual(quote.objective.lendablePoints, {seven_day: 90 - index * 3, five_hour: 99 - index * 3});

    const grant = await f.candidate.reserve(args);
    assert.equal(grant.ok, true, `chunk ${id}: ${grant.policyReason ?? grant.reason}`);
    assert.equal(grant.maxBudgetUsd, 1.68, 'native cap leaves one worst-call headroom from the $3 total');
    await f.candidate.started(args.attemptId, {ok: true});
    f.clock.at += 1; // the settlement meter reading must be newer than the reservation aggregate
    f.source.state.used.weekly += 3 * MICRO;
    f.source.state.used.short += 3 * MICRO;
    await f.candidate.recordCleanup(args.attemptId, {removed: true});
    const settled = await f.candidate.finish({attemptId: args.attemptId, provider: 'claude', model: HAIKU,
      execution: {stdout: '', lending_meter: {model: HAIKU, cost_usd: 3, final: true}}});
    assert.equal(settled.metered.units_micro, 3 * MICRO);
    assert.equal(settled.cessation.applied, false);
    assert.equal(settled.cessation.reason, 'usage_unreconciled');
    const attempt = f.adapter.state().attempts.find(row => row.id === args.attemptId);
    assert.equal(attempt.process_state, 'ceased');
    assert.equal(attempt.hold_closed, false);
    assert.equal(attempt.resources.reduce((sum, row) => sum + row.spent_micro, 0), 6 * MICRO,
      'the job-reported burn is recorded in both provider windows');
    assert.equal(attempt.resources.reduce((sum, row) => sum + row.held_micro, 0), 0);
    assert.equal(attempt.resources.reduce((sum, row) => sum + row.unrepresented_micro, 0), 6 * MICRO,
      'the recorded burn remains unresolved without interval coverage');
    assert.ok(attempt.resources.every(row => row.held_micro + row.unrepresented_micro === row.initial_micro && row.released_micro === 0));
    assert.equal(attempt.resources.reduce((sum, row) => sum + row.burns.length, 0), 2,
      'one durable burn record per resource; no duplicate settlement');
  }
  assert.equal(f.source.state.used.weekly, 12 * MICRO, 'the owner and one job appear in the provider aggregate');
  assert.equal(f.source.state.used.short, 3 * MICRO, 'the short meter records the same job movement');
  assert.equal(f.adapter.state().attempts.length, 1);
  assert.equal(f.adapter.state().attempts[0].hold_closed, false, 'the first chunk remains unresolved until coverage or reset');
  assert.equal(f.adapter.state().attempts[0].resources.reduce((sum, row) => sum + row.unrepresented_micro, 0), 6 * MICRO);
  assert.equal(f.adapter.state().attempts.reduce((sum, attempt) =>
    sum + attempt.resources.reduce((total, row) => total + row.held_micro, 0), 0), 0);
});

test('(b) durable admission holds the exact 2-point request when owner band protection consumes weekly slack', async t => {
  const ownerScenarios = [{probability: 1, attempts: [{
    need: {seven_day: 20, five_hour: 20}, value: 20, atomic: false,
  }]}];
  // With the declared whole-point unit the weekly spare is 100 - 79 - 1 = 20 points, the 20 the owner band protects, so no weekly
  // point lends. The five-hour spare is 100 - 40 - 1 = 59, and the owner band takes 20 of it, leaving 39.
  const f = fixture(t, {used: {weekly: 79 * MICRO, short: 40 * MICRO}, historyScore: 10,
    profile: {friendValue: 1, estimateUsdMicro: 2 * MICRO, forecastPoints: {seven_day: 10, five_hour: 10}, ownerScenarios}});
  const quote = await decision(f, 'heavy', {requestedUsd: 2});
  assert.equal(quote.admitted, false);
  assert.equal(quote.objective.reasonCode, 'objective_owner_reserve');
  assert.equal(quote.objective.expectedOwnerHarm, 2);
  assert.deepEqual(quote.objective.protectedOwnerPoints, {seven_day: 20, five_hour: 20});
  assert.deepEqual(quote.objective.lendablePoints, {seven_day: 0, five_hour: 39});
  const grant = await f.candidate.reserve(attemptJob('heavy', f.clock.at, {requestedUsd: 2}));
  assert.equal(grant.ok, false);
  assert.equal(grant.policyReason, 'owner_reserve');
  assert.equal(f.adapter.state().attempts.length, 0, 'a held request does not create a durable reservation');
});

test('(c) seeded whole-week history and the owner total-spend cap produce the exact model native budgets', async t => {
  const cases = [
    [HAIKU, 10_680_000],
    ['claude-sonnet-5-5', 6_720_000],
    ['claude-opus-5-5', 1_440_000],
  ];
  for (const [index, [model, expectedNative]] of cases.entries()) {
    const f = fixture(t, {used: {weekly: 84_200_000, short: 68_400_000},
      kappa: {weekly: 790_000, short: 1_580_000}, ownerCapUsd: 12,
      profile: {friendValue: 100, estimateUsdMicro: 20 * MICRO}});
    const quote = await decision(f, `model-${index}`, {model, requestedUsd: null});
    assert.equal(quote.admitted, true, quote.reason);
    assert.deepEqual(quote.objective.protectionSource, {seven_day: 'history', five_hour: 'history'});
    assert.equal(quote.objective.maximumExposureUsd, 12);
    assert.equal(quote.objective.nativeMaxBudgetUsd, expectedNative / MICRO);
    const args = attemptJob(`model-${index}`, f.clock.at, {requestedUsd: null});
    args.model = model;
    const grant = await f.candidate.reserve(args);
    assert.equal(grant.ok, true, grant.policyReason ?? grant.reason);
    assert.equal(Math.round(grant.maxBudgetUsd * MICRO), expectedNative);
    assert.equal(f.adapter.state().attempts[0].resources.reduce((sum, row) => sum + row.initial_micro, 0), 28_440_000,
      'the $12 total cap reserves 9.48 weekly and 18.96 short-window points');
  }
});

test('(d) a total-spend cap below the worst call holds with budget_too_small and the same surfaced decision', async t => {
  const f = fixture(t, {ownerCapUsd: 1, profile: {friendValue: 3, estimateUsdMicro: 3 * MICRO}});
  const quote = await decision(f, 'too-small', {requestedUsd: 3});
  assert.equal(quote.admitted, false);
  assert.equal(quote.objective.reasonCode, 'budget_too_small');
  assert.equal(quote.objective.maximumExposureUsd, 1);
  assert.equal(quote.objective.nativeMaxBudgetUsd, 0);
  assert.equal(quote.objective.reasonText,
    'Your per-job limit of $1.00 is below what one Claude Haiku 5.5 call can cost ($1.33). Raise it to at least $1.33.');
  const grant = await f.candidate.reserve(attemptJob('too-small', f.clock.at, {requestedUsd: 3}));
  assert.equal(grant.ok, false);
  assert.equal(grant.policyReason, 'budget_too_small');
  assert.equal(f.candidate.decisionFor('claude').objective.reasonText, quote.objective.reasonText);
  assert.equal(f.adapter.state().attempts.length, 0);
});

test('an early model-cap hold respects a lower signed request without observing or reserving', async t => {
  const f = fixture(t, {ownerCapUsd: 1});
  f.source.observe = async () => { throw new Error('early cap hold must not observe'); };
  const quote = await decision(f, 'lower-request', {requestedUsd: 0.5});
  assert.equal(quote.admitted, false);
  assert.equal(quote.objective.maximumExposureUsd, 0.5);
  assert.equal(quote.objective.nativeMaxBudgetUsd, 0);
  assert.equal(quote.objective.reasonText,
    // The owner's $1 cap is also below one call, so raising only the job limit would not help: the owner is named.
    'Your per-job limit of $1.00 is below what one Claude Haiku 5.5 call can cost ($1.33). Raise it to at least $1.33.');
  const grant = await f.candidate.reserve(attemptJob('lower-request', f.clock.at, {requestedUsd: 0.5}));
  assert.equal(grant.ok, false);
  assert.equal(grant.policyReason, 'budget_too_small');
  assert.deepEqual(f.candidate.decisionFor('claude').objective, quote.objective);
  assert.equal(f.adapter.state().attempts.length, 0);
});

test('(e) no-history day one is model-conditioned, not a history gate: the optimistic model admits at explicitly selected Balanced', async t => {
  // This checks the model path at an explicitly selected Balanced dial position, not the app default.
  const f = fixture(t, {used: {weekly: 2 * MICRO, short: 6 * MICRO}, historyWeeks: 0,
    resets: {weekly: 148 * 60 * 60 * 1000, short: 2 * 60 * 60 * 1000},
    profile: {position: 'balanced', friendValue: 100, estimateUsdMicro: 3 * MICRO}});
  const quote = await decision(f, 'day-one', {requestedUsd: 3});
  assert.equal(quote.admitted, true, quote.reasonCode);
  assert.deepEqual(quote.objective.protectionSource, {seven_day: 'model', five_hour: 'model'});
  assert.match(quote.objective.demandModelLabel, /declared prior/);
});

test('automatic, fixed_share and custom change the same durable request decision and expose their strategy', async t => {
  const cases = [
    ['automatic', undefined, 89, 'history'],
    ['fixed_share', {fixedSharePct:20,keepPct:30}, 20, 'history'],
    ['custom', {e0:0.5}, 40, 'history'],
  ];
  for (const [index, [strategy, strategyParams, exposure, source]] of cases.entries()) {
    const f = fixture(t, {strategy, strategyParams:{perJobPct:100,...strategyParams},
      profile:{friendValue:100, estimateUsdMicro:20 * MICRO}});
    const args = attemptJob(`strategy-${index}`, f.clock.at, {requestedUsd:null});
    const quote = await f.candidate.preview({attemptId:args.attemptId,jobId:args.jobId,job:args.job,
      provider:'claude',model:HAIKU,ownerAbsent:true});
    assert.equal(quote.admitted,true,`${strategy}: ${quote.reason}`);
    assert.equal(quote.objective.strategyId,strategy);
    assert.match(quote.objective.strategyExplanation, strategy === 'automatic' ? /dial position/
      : strategy === 'custom' ? /start at a point you choose/i : /fixed share/i);
    assert.equal(quote.objective.maximumExposureUsd,exposure);
    assert.ok(Object.values(quote.objective.protectionSource).every(value=>value===source));
    const grant=await f.candidate.reserve(args);
    assert.equal(grant.ok,true,`${strategy}: ${grant.policyReason??grant.reason}`);
    assert.equal(f.candidate.decisionFor('claude').objective.strategyId,strategy);
  }
});



test('a refresh between guard budget and settlement keeps the attempt price revision', async t => {
  const f = fixture(t);
  const args = attemptJob('price-race', f.clock.at, {requestedUsd: 3});
  const old = currentPriceCatalog();
  try {
    const grant = await f.candidate.reserve(args);
    assert.equal(grant.ok, true);
    assert.equal(f.adapter.state().attempts.find(a => a.id === args.attemptId).price_rev, old.revision);
    await f.candidate.started(args.attemptId, {ok: true});
    const refresh = startPriceRefresh({directory: f.directory, now: () => NOW,
      fetcher: async () => ({ok: true, json: async () => ({[HAIKU]: {litellm_provider: 'anthropic',
        input_cost_per_token: 0.000099, output_cost_per_token: 0.0002}})})});
    await refresh.flight; refresh.close();
    assert.notEqual(currentPriceCatalog().revision, old.revision);
    f.clock.at++;
    await f.candidate.recordCleanup(args.attemptId, {removed: true});
    const result = await f.candidate.finish({attemptId: args.attemptId, provider: 'claude', model: HAIKU,
      execution: {stdout: '', lending_meter: {model: HAIKU, tokens: {input: 1000}, cost_usd: null, final: true}}});
    assert.equal(result.metered.catalog_rev, old.revision);
    assert.equal(result.metered.units_micro, Math.ceil(old.data.list_usd[HAIKU].fresh_input_per_m * 1000));
  } finally { setLiveListPrices({}); }
});


test('a missing recorded price snapshot leaves the attempt unsettled', async t => {
  const f = fixture(t);
  const args = attemptJob('missing-price', f.clock.at, {requestedUsd: 3});
  assert.equal((await f.candidate.reserve(args)).ok, true);
  const rev = f.adapter.state().attempts.find(a => a.id === args.attemptId).price_rev;
  await f.candidate.started(args.attemptId, {ok: true});
  fs.unlinkSync(join(f.directory, 'prices', rev.replace(':', '-') + '.json'));
  const result = await f.candidate.finish({attemptId: args.attemptId, provider: 'claude', model: HAIKU,
    execution: {stdout: '', lending_meter: {model: HAIKU, cost_usd: 1, final: true}}});
  assert.equal(result.cessation.reason, 'price_snapshot_missing');
  assert.notEqual(f.adapter.state().attempts.find(a => a.id === args.attemptId).hold_closed, true);
});


test('zero fetched context cannot make a $10 cap admit Fable', async t => {
  const {parseLiteLLM} = await import('../lib/v1/litellm-prices.mjs');
  const f = fixture(t, {ownerCapUsd: 10});
  const model = 'claude-fable-5';
  try {
    setLiveListPrices(parseLiteLLM({[model]: {litellm_provider: 'anthropic', input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00005, max_input_tokens: 0}}));
    const args = attemptJob('context-zero', f.clock.at, {requestedUsd: 10});
    args.model = model;
    const grant = await f.candidate.reserve(args);
    assert.equal(grant.ok, false);
    assert.equal(grant.policyReason, 'budget_too_small');
  } finally { setLiveListPrices({}); }
});

test('an open attempt settles with its stored snapshot after the bundled table changes', async t => {
  const {spawnSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const f = fixture(t);
  const args = attemptJob('upgrade', f.clock.at, {requestedUsd: 3});
  const original = currentPriceCatalog();
  assert.equal((await f.candidate.reserve(args)).ok, true);
  await f.candidate.started(args.attemptId, {ok: true});
  f.clock.at++;
  await f.candidate.recordCleanup(args.attemptId, {removed: true});
  await f.adapter.close();

  const bundle = fs.mkdtempSync(join(tmpdir(), 'price-upgrade-bundle-'));
  t.after(() => fs.rmSync(bundle, {recursive: true, force: true}));
  const root = fileURLToPath(new URL('..', import.meta.url));
  fs.cpSync(join(root, 'lib'), join(bundle, 'lib'), {recursive: true});
  fs.mkdirSync(join(bundle, 'tests', 'helpers'), {recursive: true});
  fs.copyFileSync(join(root, 'tests', 'helpers', 'pace50-synthetic-source.mjs'),
    join(bundle, 'tests', 'helpers', 'pace50-synthetic-source.mjs'));
  const pricesPath = join(bundle, 'lib', 'v1', 'lending-prices.json');
  const prices = JSON.parse(fs.readFileSync(pricesPath, 'utf8'));
  prices.list_usd.models[HAIKU].fresh_input_per_m += 5;
  fs.writeFileSync(pricesPath, JSON.stringify(prices));
  const script = join(bundle, 'settle-after-upgrade.mjs');
  fs.writeFileSync(script, `
    import {createPace50Candidate} from './lib/v1/lender-pace50.mjs';
    import {currentPriceCatalog} from './lib/v1/lending-meter.mjs';
    import {createSyntheticPace50Source} from './tests/helpers/pace50-synthetic-source.mjs';
    const [directory, id, model, rev, start, amount] = process.argv.slice(2);
    const now = Number(start) + 1, units = Number(amount);
    const source = createSyntheticPace50Source({start: Number(start), used: {weekly: 10e6 + units, short: units},
      kappa: {weekly: 1e6, short: 1e6}});
    const opened = createPace50Candidate({postingLagBoundMs:120000,directory, now: () => now, account: 'synthetic-account',
      account_week_id: 'synthetic-week-1', source});
    try {
      const result = await opened.candidate.finish({attemptId: id, provider: 'claude', model,
        execution: {stdout: '', lending_meter: {model, tokens: {input: 1000}, cost_usd: null, final: true}}});
      process.stdout.write(JSON.stringify({result, currentRev: currentPriceCatalog().revision}));
    } finally { await opened.adapter.close(); }
  `);
  const expected = Math.ceil(original.data.list_usd[HAIKU].fresh_input_per_m * 1000);
  const child = spawnSync(process.execPath, [script, f.directory, args.attemptId, HAIKU, original.revision, String(NOW), String(expected)],
    {encoding: 'utf8', timeout: 30000});
  assert.equal(child.status, 0, child.stderr);
  const {result, currentRev} = JSON.parse(child.stdout);
  assert.notEqual(currentRev, original.revision, 'the restarted process loaded the changed bundled table');
  assert.equal(result.metered.catalog_rev, original.revision);
  assert.equal(result.metered.units_micro, expected);
  assert.equal(result.cessation.applied, false, JSON.stringify(result.cessation));
  assert.equal(result.cessation.reason, 'usage_unreconciled');
  const attempt = f.adapter.state().attempts.find(row => row.id === args.attemptId);
  assert.equal(attempt.hold_closed, false);
  assert.ok(attempt.resources.every(row => row.held_micro + row.unrepresented_micro === row.initial_micro && row.released_micro === 0));
});

test('a lower fetched alias settles a durable Codex attempt at its pinned family price', async t => {
  const {parseLiteLLM} = await import('../lib/v1/litellm-prices.mjs');
  const f = fixture(t, {strategyParams:{perJobPct:100},profile: {friendValue: 30, estimateUsdMicro: 20 * MICRO,
    ownerScenarios: [{probability: 1, attempts: [{need: {'codex:10080': 0, 'codex:300': 0}, value: 0, atomic: false}]}]}});
  const model = 'gpt-6-sol-2099';
  try {
    setLiveListPrices(parseLiteLLM({[model]: {litellm_provider: 'openai', input_cost_per_token: 0.000001,
      cache_read_input_token_cost: 0.0000001, output_cost_per_token: 0.000005}}));
    const args = {...attemptJob('alias', f.clock.at, {requestedUsd: 20}), provider: 'codex', model};
    const grant = await f.candidate.reserve(args);
    assert.equal(grant.ok, true, grant.policyReason ?? grant.reason);
    await f.candidate.started(args.attemptId, {ok: true});
    f.clock.at++;
    f.source.state.used.weekly += 4 * MICRO;
    f.source.state.used.short += 4 * MICRO;
    await f.candidate.recordCleanup(args.attemptId, {removed: true});
    const result = await f.candidate.finish({attemptId: args.attemptId, provider: 'codex', model,
      execution: {lending_meter: {model, tokens: {input: 1000000}, cost_usd: null, final: true}}});
    assert.equal(result.metered.units_micro, 4 * MICRO);
    assert.equal(result.cessation.applied, false, JSON.stringify(result.cessation));
    assert.equal(result.cessation.reason, 'usage_unreconciled');
    const attempt = f.adapter.state().attempts.find(row => row.id === args.attemptId);
    assert.equal(attempt.hold_closed, false);
    assert.ok(attempt.resources.every(row => row.held_micro + row.unrepresented_micro === row.initial_micro && row.released_micro === 0));
  } finally { setLiveListPrices({}); }
});
