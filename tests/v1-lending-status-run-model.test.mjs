import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {DEFAULT_RUN_MODEL} from "../lib/v1/lending-meter.mjs";

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';

// The app uses catalog headroom; the shared synthetic source fixes every model to Haiku's $1.32.
// Adapt that fixture to the app contract so Sonnet and Codex use their production call allowances.

test('configured model efforts use the supported effort vocabulary', async () => {
  const {configuredModelEfforts} = await import('../lib/v1/lending-run-model.mjs');
  const {SUPPORTED_RUN_EFFORTS} = await import('../lib/v1/lending-run-model.mjs');
  assert.deepEqual(SUPPORTED_RUN_EFFORTS, ['low','medium','high','xhigh','max']);
  assert.equal(Object.isFrozen(SUPPORTED_RUN_EFFORTS), true);
  for (const harness_id of ['codex','claude-code-subscription','claude-code-api-key']) {
    const pairs = SUPPORTED_RUN_EFFORTS.map(effort => ({model:'synthetic-model',effort}));
    const adapter = {spec:{harness_id},run:{model_efforts:pairs}};
    assert.deepEqual(configuredModelEfforts(adapter), pairs);

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
