import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {usageUnits} from '../lib/v1/lender-pace50.mjs';
import {emptyTokens, normalizeGuardUsage, priceCodexCredits, priceListUsd} from '../lib/v1/lending-meter.mjs';

// The candidate's usage units for one attempt. The guard's token reading is the only usage source when the Claude stream
// carries none, so it must be priced, not replaced by an empty stream object. The fallback has no per-call prompt sizes, so
// tier choice uses the aggregate prompt, which can raise a long-context price and never lower it.
const OPUS = 'claude-opus-5-5';
const HAIKU = 'claude-haiku-5-5';
const micro = (usd) => Math.round(usd * 1e6);
const guard = (patch = {}) => ({input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning_output: 0, ...patch});

test('a Claude guard reading with no usage in the stream is priced from the guard tokens, not to zero', () => {
  const out = usageUnits({provider: 'claude', model: OPUS,
    execution: {stdout: '', lending_meter: {model: OPUS, tokens: guard({input: 1000000}), cost_usd: null, final: true}}});
  assert.equal(out.units_micro, micro(priceListUsd(OPUS, {...emptyTokens(), fresh_input: 1000000}).usd),
    'the list price of one million fresh input tokens');
  assert.ok(out.units_micro > 0, 'the reading is not free');
});

test('the fallback prices a long-context aggregate at the above-threshold tier, because its prompt is above the threshold', () => {
  // Haiku 5.5 has an above-threshold tier at a 100k prompt. The aggregate prompt here is 200k, so the tier must apply.
  const out = usageUnits({provider: 'claude', model: HAIKU,
    execution: {stdout: '', lending_meter: {model: HAIKU, tokens: guard({input: 200000}), cost_usd: null, final: true}}});
  const aboveTier = priceListUsd(HAIKU, {...emptyTokens(), fresh_input: 200000},
    {calls: [{...emptyTokens(), fresh_input: 200000, prompt: 200000}]}).usd;
  assert.equal(out.units_micro, micro(aboveTier), 'the aggregate is priced at the tier its prompt reaches');
});

test('control: a stream that carries usage keeps its own tokens and per-call prompts, so it wins over the guard reading', () => {
  const line = JSON.stringify({type: 'assistant', message: {id: 'msg-1', model: OPUS,
    usage: {input_tokens: 1000, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0}}});
  const out = usageUnits({provider: 'claude', model: OPUS,
    // The stream ends with a successful result, so it is the run's complete total and wins over the guard reading.
    execution: {stdout: `${line}\n${JSON.stringify({type: 'result', subtype: 'success', is_error: false})}\n`,
      lending_meter: {model: OPUS, tokens: guard({input: 5}), cost_usd: null, final: true}}});
  assert.equal(out.units_micro, micro(priceListUsd(OPUS, {...emptyTokens(), fresh_input: 1000},
    {calls: [{...emptyTokens(), fresh_input: 1000, prompt: 1000}]}).usd), 'the stream usage is priced, not the guard reading');
});

test('the Codex path bills the guard reading in list USD, the unit of admission and κ, and keeps the credits', () => {
  const tokens = guard({input: 1000000});
  const out = usageUnits({provider: 'codex', model: 'gpt-6-sol',
    execution: {stdout: '', lending_meter: {model: 'gpt-6-sol', tokens, cost_usd: null, final: true}}});
  const normalized = normalizeGuardUsage('codex', tokens);
  const prompt = normalized.fresh_input + normalized.cache_read + normalized.cache_write_5m + normalized.cache_write_1h;
  assert.equal(out.units_micro, micro(priceListUsd('gpt-6-sol', normalized, {calls: [{...normalized, prompt}]}).usd),
    'the list USD for the normalized guard tokens, at the prompt\'s price tier');
  assert.equal(out.metered.priced_units, priceCodexCredits('gpt-6-sol', normalized).credits, 'the credits stay on the receipt');
});
