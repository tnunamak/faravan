import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {claudeCallHeadroomUsd, DEFAULT_RUN_MODEL} from '../lib/v1/lending-meter.mjs';
import {minimumMaxJobUsdForModel} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK} from './helpers/pace50-fixtures.mjs';
import {LINES} from '../lib/v1/lending-status-copy.mjs';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';

test('a failed first provider reading reports the current hold without model conversion evidence', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'status-first-reading-'));
  let calls = 0;
  const runtime = createLendingRuntime({directory, now:() => NOW,
    settings:() => ({enabled:true, intent:'on', agentRun:{'claude-code-subscription':{model:HAIKU}}}),
    pace50:{account:ACCOUNT, account_week_id:WEEK, source:{observe:async () => {
      calls++;
      return {refresh_succeeded:false, complete:false, resources:[], probe:{provider:'claude', reason:'probe_unavailable'}};
    }}}});
  t.after(async () => {await runtime.close(); fs.rmSync(directory, {recursive:true, force:true});});
  assert.equal((await runtime.candidate.projectStatus({provider:'claude', snapshotOnly:true})).reason,
    'objective_evidence_unknown', 'no probe has completed yet');
  await runtime.candidate.observe({provider:'claude', now:NOW});
  const projected = await runtime.candidate.projectStatus({provider:'claude', snapshotOnly:true});
  assert.equal(projected.reason, 'refresh_failed');
  assert.equal(projected.objective, null, 'failed provider evidence supplies no priced estimate');
  const view = await runtime.view();
  assert.equal(view.accounts.find(row => row.provider === 'claude').decision.status.line, LINES.measured);
  assert.equal(calls, 1, 'status reads do not start a probe');
});

// The app uses catalog headroom; the shared synthetic source fixes every model to Haiku's $1.32.
// Adapt that fixture to the app contract so Sonnet and Codex use their production call allowances.
function priceWithCatalog(source, priced = []) {
  const observe = source.observe.bind(source);
  source.observe = async args => ({...await observe(args), priceModel:args.model});
  const build = source.objectiveInputFor.bind(source);
  source.objectiveInputFor = args => {
    if (args.request.objective_status && args.request.provider === 'claude')
      assert.equal(args.observation.priceModel, args.request.model, 'status uses the priced model’s evidence');
    priced.push(args.request.model);
    const input = build(args);
    input.job.worstCallUsdMicro = args.request.provider === 'claude'
      ? Math.ceil(claudeCallHeadroomUsd(args.request.model ?? DEFAULT_RUN_MODEL.claude) * 1_000_000) : 0;
    return input;
  };
  return source;
}

for (const [model, cap] of [[HAIKU, 2], [HAIKU, 1], [null, 2]]) {
  test(`status prices saved run ${model ?? 'default'} at $${cap}`, async t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'status-run-model-'));
    const settings = {limits:{lendingPolicy:{providerConsent:{claude:true}}}, agentRun: model ? {'claude-code-subscription': {model, effort:'low'}} : {}};
    const source = createSyntheticPace50Source({start: NOW});
    const priced = [];
    priceWithCatalog(source, priced);
    const runtime = createLendingRuntime({directory, settings:() => settings, presence:() => false, now:() => NOW,
      pace50:{account:ACCOUNT, account_week_id:WEEK, source, ownerSettings:{limit:() => ({state:'set', maxJobUsd:cap})}}});
    t.after(async () => {await runtime.close(); fs.rmSync(directory, {recursive:true, force:true});});
    await runtime.readings('claude');
    // Provider readings may have no model; they must not replace the owner's run choice.
    await runtime.candidate.observe({provider:'claude', now:NOW});
    assert.equal((await runtime.candidate.projectStatus({provider:'claude', snapshotOnly:true})).reason,
      'objective_evidence_unknown', 'another model or unnamed conversion cannot price this run');
    await runtime.refreshCapacity('claude');
    const status = await runtime.candidate.projectStatus({provider:'claude', snapshotOnly:true});
    if (model === HAIKU && cap === 2) {
      assert.equal(status.admitted, true, JSON.stringify(status));
    } else {
      assert.equal(status.reason, 'budget_too_small');
      assert.equal(status.objective.budgetLimit.minimumUsd, minimumMaxJobUsdForModel(model ?? DEFAULT_RUN_MODEL.claude));
      assert.equal(status.objective.budgetLimit.model, model ?? DEFAULT_RUN_MODEL.claude);
    }
    assert.equal(priced.at(-1), model ?? DEFAULT_RUN_MODEL.claude);
    const view = await runtime.view();
    const shown = view.accounts.find(account => account.provider === 'claude').decision;
    assert.equal(shown.reason, status.reason);
    assert.deepEqual(shown.objective.budgetLimit, status.objective.budgetLimit);
    if (model === HAIKU && cap === 2) {
      const held = await runtime.candidate.reserve({attemptId:'sonnet', jobId:'sonnet', provider:'claude', model:SONNET,
        automatic:false, ownerAbsent:true, job:{requirements:{limits:{wall_seconds:300}}, expires_at:new Date(NOW + 3600e3).toISOString()}});
      assert.equal(held.ok, false);
      assert.equal(held.policyReason, 'budget_too_small');
      assert.equal(runtime.candidate.decisionFor('claude').objective.budgetLimit.model, SONNET);
      settings.agentRun['claude-code-subscription'].model = SONNET;
      const changed = await runtime.candidate.projectStatus({provider:'claude', snapshotOnly:true});
      assert.equal(changed.reason, 'objective_evidence_unknown');
      const refreshed = await runtime.refreshCapacity('claude');
      assert.equal(refreshed.objective.budgetLimit.model, SONNET);
      assert.equal(refreshed.objective.budgetLimit.minimumUsd, minimumMaxJobUsdForModel(SONNET));
    }
  });
}

test('shared refresh keeps the base fallback regardless of run preferences', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'status-refresh-model-'));
  const settings = {agentRun:{'claude-code-subscription':{model:SONNET}}};
  const seen = [];
  const source = createSyntheticPace50Source({start:NOW});
  const observe = source.observe;
  source.observe = args => {seen.push(args.model); return observe(args);};
  const runtime = createLendingRuntime({directory, settings:() => settings, now:() => NOW,
    pace50:{account:ACCOUNT, account_week_id:WEEK, source}});
  t.after(async () => {await runtime.close(); fs.rmSync(directory, {recursive:true, force:true});});
  await runtime.candidate.refreshObservation({provider:'claude', now:NOW});
  settings.agentRun['claude-code-subscription'].model = HAIKU;
  await runtime.candidate.refreshObservation({provider:'claude', now:NOW});
  await runtime.readings('claude', {forceRefresh:true});
  assert.deepEqual(seen, ['claude-haiku-4-5', 'claude-haiku-4-5', 'claude-haiku-4-5']);
});

for (const run of [
  {model:'claude-unpriced-9'},
  {model:HAIKU, model_efforts:[{model:HAIKU, effort:'low'}, {model:SONNET, effort:'high'}]},
  {model:HAIKU, model_efforts:[{model:HAIKU, effort:'low'}]},
  {model:HAIKU, model_efforts:[{model:HAIKU, effort:'low'}, {model:SONNET, effort:'low'}]},
  {model_efforts:[{model:HAIKU, effort:'low'}]},
]) {
  test('status covers unpriced models and effort pairs ' + JSON.stringify(run), async t => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'status-pairs-'));
    const runtime = createLendingRuntime({directory, settings:() => ({agentRun:{'claude-code-subscription':run}}),
      presence:() => false, now:() => NOW,
      pace50:{account:ACCOUNT, account_week_id:WEEK, source:priceWithCatalog(createSyntheticPace50Source({start:NOW})),
        ownerSettings:{limit:() => ({state:'set', maxJobUsd:2})}}});
    t.after(async () => {await runtime.close(); fs.rmSync(directory, {recursive:true, force:true});});
    const result = await runtime.refreshCapacity('claude');
    if (run.model === 'claude-unpriced-9') assert.equal(result.reason, 'model_unpriced');
    else if (run.model_efforts.length === 2 || !run.model) {
      assert.equal(result.reason, 'budget_too_small');
      assert.equal(result.objective.budgetLimit.model, SONNET);
    } else assert.equal(result.admitted, true, JSON.stringify(result));
  });
}

for (const [provider, model] of [['claude', HAIKU], ['claude', null], ['codex', 'gpt-6-sol']]) {
  test('real-job money is independent of saved run ' + provider + ':' + model, async t => {
    const results = [];
    for (const runModel of [HAIKU, SONNET]) {
      const directory = fs.mkdtempSync(join(tmpdir(), 'status-money-'));
      const runtime = createLendingRuntime({directory, settings:() => ({agentRun:{'claude-code-subscription':{model:runModel}}}),
        now:() => NOW, pace50:{account:ACCOUNT, account_week_id:WEEK,
          source:priceWithCatalog(createSyntheticPace50Source({start:NOW})),
          ownerSettings:{limit:() => ({state:'set', maxJobUsd:10})}}});
      t.after(async () => {await runtime.close(); fs.rmSync(directory, {recursive:true, force:true});});
      const out = await runtime.candidate.reserve({attemptId:'money', jobId:'money', provider, model,
        automatic:false, ownerAbsent:true, job:{requirements:{limits:{wall_seconds:300}},
          budget_v1:{max_list_usd:8}, expires_at:new Date(NOW + 3600e3).toISOString()}});
      if (provider === 'claude' && model === null) {
        assert.equal(out.ok, false);
        assert.equal(out.policyReason, 'model_unpriced');
        assert.equal(runtime.pace50.state().attempts.length, 0);
        results.push({held:'model_unpriced', exposure:0, native:0, resources:[]});
        continue;
      }
      assert.equal(out.ok, true, JSON.stringify(out));
      const objective = runtime.candidate.lastJobDecisionFor(provider).objective;
      results.push({exposure:objective.maximumExposureUsd, native:objective.nativeMaxBudgetUsd,
        resources:runtime.pace50.state().attempts[0].resources.map(r => ({id:r.id, held:r.held_micro, kappa:r.kappa_micro}))});
    }
    assert.deepEqual(results[0], results[1]);
    const ids = provider === 'claude' ? ['seven_day', 'five_hour'] : ['codex:10080', 'codex:300'];
    assert.deepEqual(results[0], provider === 'claude' && model === null
      ? {held:'model_unpriced', exposure:0, native:0, resources:[]}
      : {exposure:8, native:provider === 'claude' ? 6.68 : 8,
        resources:ids.map((id, i) => ({id, held:[400000,1600000][i], kappa:[50000,200000][i]}))});
  });
}

test('a no-model job resolves the owner run model before reserving, independently of status', async t => {
  const {resolveLenderRunModel} = await import('../lib/v1/lending-run-model.mjs');
  for (const statusModel of [HAIKU, SONNET]) {
    const directory = fs.mkdtempSync(join(tmpdir(), 'status-resolved-money-'));
    const job = {requirements:{limits:{wall_seconds:300}}, budget_v1:{max_list_usd:8},
      expires_at:new Date(NOW + 3600e3).toISOString()};
    const adapter = {spec:{harness_id:'claude-code-subscription'}, run:{model:HAIKU}};
    const runtime = createLendingRuntime({directory, settings:() => ({}), now:() => NOW,
      pace50:{account:ACCOUNT, account_week_id:WEEK, statusRunModel:() => statusModel,
        source:priceWithCatalog(createSyntheticPace50Source({start:NOW})),
        ownerSettings:{limit:() => ({state:'set', maxJobUsd:10})}}});
    t.after(async () => {await runtime.close(); fs.rmSync(directory, {recursive:true, force:true});});
    const model = resolveLenderRunModel(adapter, job);
    assert.equal(model, HAIKU);
    const out = await runtime.candidate.reserve({attemptId:'resolved', jobId:'resolved', job,
      provider:'claude', model, automatic:false, ownerAbsent:true});
    assert.equal(out.ok, true);
    const objective = runtime.candidate.lastJobDecisionFor('claude').objective;
    assert.equal(objective.maximumExposureUsd, 8);
    assert.equal(objective.nativeMaxBudgetUsd, 6.68);
    assert.deepEqual(runtime.pace50.state().attempts[0].resources.map(r => r.held_micro), [400000,1600000]);
  }
});

test('configured model efforts share the automatic selection effort vocabulary', async () => {
  const {configuredModelEfforts} = await import('../lib/v1/lending-run-model.mjs');
  const {SUPPORTED_RUN_EFFORTS, selectAutoRun} = await import('../lib/v1/auto-run-selection.mjs');
  assert.deepEqual(SUPPORTED_RUN_EFFORTS, ['low','medium','high','xhigh','max']);
  assert.equal(Object.isFrozen(SUPPORTED_RUN_EFFORTS), true);
  for (const harness_id of ['codex','claude-code-subscription','claude-code-api-key']) {
    const pairs = SUPPORTED_RUN_EFFORTS.map(effort => ({model:'synthetic-model',effort}));
    const adapter = {spec:{harness_id},run:{model_efforts:pairs}};
    assert.deepEqual(configuredModelEfforts(adapter), pairs);
    const selected = selectAutoRun({intent:'strongest',pairs:configuredModelEfforts(adapter),
      cap:'max',rank:{'synthetic-model':1},prices:{revision:'synthetic',usd:() => 1}});
    assert.equal(selected.ok,true);
    assert.deepEqual(selected.pair,{model:'synthetic-model',effort:'max'});
    const capped = selectAutoRun({intent:'strongest',pairs,cap:'xhigh',
      rank:{'synthetic-model':1},prices:{revision:'synthetic',usd:() => 1}});
    assert.equal(capped.ok,true);
    assert.equal(capped.pair.effort,'xhigh');
  }
});

test('unknown effort drops only that pair and reports it without throwing from status', async () => {
  const {configuredModelEfforts,configuredModelEffortsResult,resolveLenderStatusModel} = await import('../lib/v1/lending-run-model.mjs');
  const valid = [{model:HAIKU,effort:'low'},{model:SONNET,effort:'max'}];
  const invalid = {model:'synthetic-bad',effort:'turbo'};
  for (const harness_id of ['codex','claude-code-subscription','claude-code-api-key']) {
    for (const pairs of [[invalid],[valid[0],invalid,valid[1]],[invalid,...valid],[...valid,invalid]]) {
      const original = structuredClone(pairs);
      const adapter = {spec:{harness_id},run:{model:HAIKU,model_efforts:pairs}};
      const result = configuredModelEffortsResult(adapter);
      assert.deepEqual(result.pairs,pairs.filter(pair => pair !== invalid));
      assert.deepEqual(result.invalidPairs,[{index:pairs.indexOf(invalid),...invalid}]);
      assert.deepEqual(result.problems,[{code:'unsupported_effort',index:pairs.indexOf(invalid)}]);
      assert.deepEqual(configuredModelEfforts(adapter),result.pairs);
      assert.doesNotThrow(() => resolveLenderStatusModel(adapter));
      assert.deepEqual(pairs,original,'validation never rewrites saved owner choices');
    }
  }
});

test('malformed model effort configuration reports named problems and remains fail-closed', async () => {
  const {configuredModelEfforts,configuredModelEffortsResult,resolveLenderRunModel,resolveLenderStatusModel} = await import('../lib/v1/lending-run-model.mjs');
  const adapter = run => ({spec:{harness_id:'codex'},run});
  const cases = [
    [[], 'empty_model_efforts'],
    [{}, 'model_efforts_not_array'],
    [Array.from({length:33},(_,i) => ({model:'m'+i,effort:'low'})), 'too_many_model_effort_pairs'],
    [Array.from({length:17},(_,i) => ({model:'m'+i,effort:'low'})), 'too_many_models'],
    [[{model:'m',effort:'low'},{model:'m',effort:'low'}], 'duplicate_model_effort_pair'],
    [[{model:'m',effort:'low',extra:true}], 'unknown_model_effort_key'],
    [[null], 'invalid_model_effort_pair'],
    [[{model:'bad model',effort:'low'}], 'invalid_model_name'],
    [[{model:'m'}], 'invalid_model_effort_pair'],
  ];
  for (const [model_efforts,code] of cases) {
    const input = adapter({model_efforts});
    const result = configuredModelEffortsResult(input);
    assert.deepEqual(result.pairs,[]);
    assert.ok(result.problems.some(problem => problem.code === code),JSON.stringify(result));
    assert.deepEqual(configuredModelEfforts(input),[]);
    assert.doesNotThrow(() => resolveLenderStatusModel({...input,spec:{harness_id:'claude-code-subscription'}}));
  }
  assert.deepEqual(configuredModelEfforts(adapter({model:'saved',effort:'high'})),[{model:'saved',effort:'high'}]);
  assert.deepEqual(configuredModelEfforts(adapter({model:'saved',effort:'max'})),[],
    'GAP: legacy scalar effort acceptance deliberately unchanged');
  assert.equal(resolveLenderRunModel(adapter({model:'saved'})),'saved');
  assert.equal(resolveLenderRunModel(adapter({})),DEFAULT_RUN_MODEL.codex);
});

test('Codex status carries the run model through to the lending rule', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'codex-status-model-'));
  const priced = [];
  const runtime = createLendingRuntime({directory, settings:() => ({}), now:() => NOW,
    pace50:{account:ACCOUNT, account_week_id:WEEK,
      source:priceWithCatalog(createSyntheticPace50Source({start:NOW}), priced)}});
  t.after(async () => {await runtime.close(); fs.rmSync(directory, {recursive:true, force:true});});
  await runtime.refreshCapacity('codex');
  assert.equal(priced.at(-1), DEFAULT_RUN_MODEL.codex);
});
