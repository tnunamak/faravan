import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {selectAutoRun, AUTO_RUN_RULE_VERSION, CAPABILITY_RANK, listPriceSnapshot, supportedAutoIntents} from '../lib/v1/auto-run-selection.mjs';

// A pure choice: intent, the pairs this lender offers, the effort cap, a rank table and a price snapshot go in; one
// exact pair comes out. No clock, no I/O, no model call.
const prices = {revision: 'prices-sha256:test', usd: model => ({'cheap-model': 1, 'mid-model': 3, 'big-model': 15}[model] ?? null)};
const rank = {'cheap-model': 1, 'mid-model': 2, 'big-model': 3};
const pairs = [
  {model: 'cheap-model', effort: 'low'}, {model: 'cheap-model', effort: 'high'},
  {model: 'mid-model', effort: 'low'}, {model: 'mid-model', effort: 'medium'}, {model: 'mid-model', effort: 'high'},
  {model: 'big-model', effort: 'medium'}, {model: 'big-model', effort: 'high'},
];
const select = (intent, over = {}) => selectAutoRun({intent, pairs, cap: 'high', rank, prices, ...over});

test('cheapest picks the lowest list price at its lowest effort, not the lender default', () => {
  const out = select('cheapest');
  assert.equal(out.ok, true);
  assert.deepEqual(out.pair, {model: 'cheap-model', effort: 'low'});
  assert.equal(out.rule_version, AUTO_RUN_RULE_VERSION);
  assert.equal(out.pricing_revision, 'prices-sha256:test');
  assert.equal(out.capped, false);
  assert.equal(typeof out.reason, 'string');
});

test('strongest picks the highest-ranked model at its highest effort under the cap', () => {
  assert.deepEqual(select('strongest').pair, {model: 'big-model', effort: 'high'});
  const capped = select('strongest', {cap: 'medium'});
  assert.deepEqual(capped.pair, {model: 'big-model', effort: 'medium'});
  assert.equal(capped.capped, true, 'the cap lowered the effort, and the choice says so');
  assert.equal(select('strongest').capped, false);
});

test('when the cap removes every pair of the strongest model, the next model is chosen and marked capped', () => {
  const only = [{model: 'mid-model', effort: 'low'}, {model: 'big-model', effort: 'high'}];
  const out = selectAutoRun({intent: 'strongest', pairs: only, cap: 'medium', rank, prices});
  assert.deepEqual(out.pair, {model: 'mid-model', effort: 'low'});
  assert.equal(out.capped, true);
});

test('the order the lender lists its pairs in never changes the choice', () => {
  const permutations = items => items.length < 2 ? [items] : items.flatMap((x, i) => permutations([...items.slice(0, i), ...items.slice(i + 1)]).map(rest => [x, ...rest]));
  const small = pairs.slice(0, 5), expected = {};
  for (const intent of ['cheapest', 'strongest']) {
    expected[intent] = selectAutoRun({intent, pairs: small, cap: 'high', rank, prices}).pair;
    for (const order of permutations(small)) assert.deepEqual(selectAutoRun({intent, pairs: order, cap: 'high', rank, prices}).pair, expected[intent]);
  }
  assert.deepEqual(selectAutoRun({intent: 'strongest', pairs: [...pairs].reverse(), cap: 'high', rank, prices}).pair, select('strongest').pair);
});

test('ties break on a stable model id, and an unknown rank or price is never evidence of anything', () => {
  const tie = [{model: 'b-model', effort: 'low'}, {model: 'a-model', effort: 'low'}];
  const same = {usd: () => 2, revision: 'r'};
  assert.equal(selectAutoRun({intent: 'cheapest', pairs: tie, cap: 'high', rank: {}, prices: same}).pair.model, 'a-model');
  // No price: the pair cannot be called cheapest. No rank: the pair cannot be called strongest.
  const unknown = [{model: 'mystery', effort: 'low'}, {model: 'cheap-model', effort: 'medium'}];
  assert.equal(selectAutoRun({intent: 'cheapest', pairs: unknown, cap: 'high', rank, prices}).pair.model, 'cheap-model');
  assert.equal(selectAutoRun({intent: 'strongest', pairs: unknown, cap: 'high', rank, prices}).pair.model, 'cheap-model');
});

test('no eligible pair means no choice, and no pair is ever invented or lowered to fit', () => {
  const none = selectAutoRun({intent: 'cheapest', pairs: [{model: 'mid-model', effort: 'high'}], cap: 'low', rank, prices});
  assert.equal(none.ok, false);
  assert.equal(none.pair, undefined);
  assert.equal(selectAutoRun({intent: 'cheapest', pairs: [], cap: 'high', rank, prices}).ok, false);
  assert.equal(selectAutoRun({intent: 'cheapest', pairs: [{model: 'mystery', effort: 'low'}], cap: 'high', rank, prices}).ok, false);
  for (const intent of [undefined, '', 'best', 'auto', 'cheapest ']) assert.equal(selectAutoRun({intent, pairs, cap: 'high', rank, prices}).ok, false);
  // Every answer is one of the offered pairs.
  for (const cap of ['low', 'medium', 'high']) for (const intent of ['cheapest', 'strongest']) {
    const out = selectAutoRun({intent, pairs, cap, rank, prices});
    if (out.ok) assert.ok(pairs.some(p => p.model === out.pair.model && p.effort === out.pair.effort));
  }
});

test('the rank table and the price snapshot come from the shipped data', () => {
  assert.ok(Object.isFrozen(CAPABILITY_RANK));
  assert.ok(CAPABILITY_RANK['claude-haiku-5-5'] < CAPABILITY_RANK['claude-sonnet-5-5']);
  assert.ok(CAPABILITY_RANK['claude-sonnet-5-5'] < CAPABILITY_RANK['claude-opus-5-5']);
  const snapshot = listPriceSnapshot();
  assert.match(snapshot.revision, /^prices-sha256:/);
  assert.ok(snapshot.usd('claude-haiku-5-5') < snapshot.usd('claude-opus-5-5'));
  assert.equal(snapshot.usd('not-a-real-model'), null);
});

test('the price snapshot is an input: without one there is no choice, and the catalog is never read behind the caller', () => {
  const out = selectAutoRun({intent: 'cheapest', pairs, cap: 'high', rank});
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'no_price_snapshot');
  assert.equal(selectAutoRun({intent: 'strongest', pairs, cap: 'high', rank, prices}).ok, true);
});

test('a lender says which choices its own pairs can satisfy, each by the same rule that later picks the pair', () => {
  const snapshot = listPriceSnapshot();
  const pair = model => ({model, effort: 'low'});
  assert.deepEqual(supportedAutoIntents({pairs: [pair('gpt-6-luna')], prices: snapshot}), ['cheapest', 'strongest'], 'ranked and priced');
  assert.deepEqual(supportedAutoIntents({pairs: [pair('gpt-5.4-mini')], prices: snapshot}), ['cheapest'], 'priced, but with no rank it can never be strongest');
  assert.deepEqual(supportedAutoIntents({pairs: [pair('a-model-nobody-priced')], prices: snapshot}), [], 'neither priced nor ranked');
  assert.deepEqual(supportedAutoIntents({pairs: [], prices: snapshot}), []);
  assert.deepEqual(supportedAutoIntents({pairs: [pair('gpt-5.4-mini'), pair('gpt-6-luna')], prices: snapshot}),
    supportedAutoIntents({pairs: [pair('gpt-6-luna'), pair('gpt-5.4-mini')], prices: snapshot}), 'the order of the pairs changes nothing');
  assert.deepEqual(supportedAutoIntents({pairs: [pair('gpt-6-luna')]}), [], 'without a price snapshot there is no promise');
});
