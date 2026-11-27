import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {opById} from '../lib/v1/ops/registry.mjs';
import {validate} from '../lib/v1/ops/schema.mjs';
import {LENDING_PARAMETERS, LENDING_STRATEGIES, LENDING_STRATEGY_IDS} from '../lib/v1/lending-policy.mjs';
import {PROTECTION_POSITIONS} from '../lib/v1/lending-objective.mjs';

// The strategies and the dial are read from the engine, not copied, and a bad value is refused by name before the engine sees it.

test('lending.strategies returns the engine values: strategy ids, what each one reads, and the dial epsilon', async () => {
  const out = await opById('lending.strategies').handler();
  assert.deepEqual(out.strategies.map(strategy => strategy.id), LENDING_STRATEGY_IDS);
  for (const strategy of out.strategies) {
    assert.ok(strategy.label && strategy.description.length > 0, strategy.id + ' has a label and a line');
    assert.deepEqual(strategy.parameters.map(p => p.key), LENDING_STRATEGIES[strategy.id].applies, strategy.id + ' lists what it reads');
    for (const p of strategy.parameters) {
      assert.equal(p.type, 'number', p.key);
      assert.equal(p.minimum, LENDING_PARAMETERS[p.key].minimum, p.key);
      assert.equal(p.maximum, LENDING_PARAMETERS[p.key].maximum, p.key);
      assert.equal(p.default, LENDING_PARAMETERS[p.key].default ?? null, p.key);
    }
  }
  assert.deepEqual(out.dials.map(dial => [dial.position, dial.epsilon]),
    Object.entries(PROTECTION_POSITIONS).map(([position, dial]) => [position, dial.epsilon]));
  assert.deepEqual(out.dials.map(dial => dial.epsilon), [0.1, 0.25, 0.5]);
});

test('limits.set types the lending policy: the strategy and dial enums, and each number with its range', () => {
  const policy = opById('limits.set').input.properties.lendingPolicy;
  assert.deepEqual(policy.properties.strategy.enum, LENDING_STRATEGY_IDS);
  assert.deepEqual(policy.properties.protectionPosition.enum, Object.keys(PROTECTION_POSITIONS));
  assert.doesNotMatch(policy.properties.protectionPosition.description, /epsilon/, 'epsilons are read from lending.strategies');
  // The surface types each number; the engine checks its range (tests/v1-lending-param-validation.test.mjs).
  assert.equal(policy.properties.strategyParams.properties.fixedSharePct.type, 'number');
  assert.equal(policy.properties.strategyParams.properties.e0.maximum, 0.5, 'the range is typed here');
  assert.equal(policy.properties.strategyParams.properties.e0.default, undefined, 'the default is read from lending.strategies');
});

test('a bad strategy, dial or parameter is refused by name, with its field, before the engine sees it', () => {
  const input = opById('limits.set').input;
  const refusal = lendingPolicy => {
    try { validate(input, {lendingPolicy}); return null; } catch (error) { return error; }
  };
  const strategy = refusal({strategy: 'mystery'});
  assert.equal(strategy?.code, 'invalid_request');
  assert.equal(strategy.field, 'lendingPolicy.strategy');
  assert.match(strategy.message, /must be one of automatic, fixed_share, custom/);
  const dial = refusal({protectionPosition: 'extreme'});
  assert.equal(dial?.code, 'invalid_request');
  assert.equal(dial.field, 'lendingPolicy.protectionPosition');
  assert.match(dial.message, /must be one of keep_more_for_me, balanced, share_more/);
  const param = refusal({strategy: 'fixed_share', strategyParams: {fixedSharePct: '20'}});
  assert.equal(param?.field, 'lendingPolicy.strategyParams.fixedSharePct');
  assert.match(param.message, /must be number/);
  const unknown = refusal({effort: 'max'});
  assert.equal(unknown?.field, 'lendingPolicy.effort');
  assert.equal(refusal({strategy: 'custom', protectionPosition: 'share_more', strategyParams: {e0: 0.5}}), null, 'a valid choice passes');
});
