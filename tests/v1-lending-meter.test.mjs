import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseCodexRateLimits, parseClaudeStream, parseClaudeRateLimit, parseCodexRollout, parseClaudeUsage, parseCodexUsage, parseGuardMeterLine,
  normalizeGuardUsage, priceListUsd, priceCodexCredits, meterJob, publicBudgetReceipt, modelFamily, emptyTokens, PRICE_CATALOG, jobUsage } from '../lib/v1/lending-meter.mjs';

import { lendingQuotaLinesVM } from '../ui/v1/src/view-models.mjs';

const fixture = name => readFileSync(new URL('./fixtures/lending/' + name, import.meta.url), 'utf8');
const T = Date.parse('2026-10-20T13:31:00Z');

test('Claude stream golden (Phase 0 budget run): tokens by class with 1h cache, own cost, budget stop, readings', () => {
  const out = parseClaudeStream(fixture('claude-budget-stream.jsonl'), { observedAt: T });
  assert.equal(out.model, 'claude-haiku-4-5-20251001');
  assert.equal(out.harness_version, '2.1.280');
  // Repeated content-block messages are counted once per message id. (The redacted fixture's per-message usage does not
  // sum to its result.usage, so the priced unit is the result's total_cost_usd, never a token re-price.)
  assert.deepEqual(out.tokens, { fresh_input: 34, cache_read: 103485, cache_write_5m: 0, cache_write_1h: 18583, output: 702, reasoning: 0 });
  assert.equal(out.cost_usd, 0.05105850000000001);
  assert.deepEqual(out.result, { subtype: 'error_max_budget_usd', is_error: true, budget_stop: true, num_turns: 4 });
  assert.deepEqual(out.readings.map(r => [r.window_id, r.window_minutes, r.used_pct, new Date(r.resets_at).toISOString(), r.state, r.source]), [
    ['five_hour', 300, 24, '2026-10-20T16:20:00.000Z', 'open', 'inband'],
    ['seven_day', 10080, 37, '2026-10-23T02:00:00.000Z', 'open', 'inband']]);
});

test('Claude rate limit: rejected and overage flags; surpassedThreshold optional', () => {
  const r = parseClaudeRateLimit({ status: 'rejected', isUsingOverage: true, unifiedWindows: { seven_day: { utilization: 1, resetsAt: 1792720800 } } }, T);
  assert.equal(r.limit_reached, true); assert.equal(r.using_overage, true); assert.equal(r.readings[0].used_pct, 100);
  assert.equal(parseClaudeRateLimit(null, T), null);
});

test('regression: expired or reset-less in-band readings are unknown/dropped, never not_open', () => {
  const past = parseClaudeRateLimit({ unifiedWindows: { seven_day: { utilization: 0.4, resetsAt: (T - 1000) / 1000 } } }, T);
  assert.equal(past.readings[0].state, 'unknown');
  const none = parseClaudeRateLimit({ unifiedWindows: { seven_day: { utilization: 0 } } }, T);
  assert.equal(none.readings.length, 0);
  const rollout = parseCodexRollout(JSON.stringify({ timestamp: new Date(T).toISOString(), payload: { type: 'token_count',
    rate_limits: { primary: { used_percent: 0, window_minutes: 10080, resets_at: null } } } }));
  assert.equal(rollout.readings.length, 0);
  // Only a probe saying "nothing used, no reset" shows a window that has not opened.
  const probe = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 604800, reset_at: null } } }, T);
  assert.equal(probe.readings[0].state, 'not_open');
  const probePast = parseClaudeUsage({ seven_day: { utilization: 30, resets_at: new Date(T - 1).toISOString() } }, T);
  assert.equal(probePast.readings[0].state, 'unknown');
});

test('Codex rollout: cumulative usage, cached and reasoning never double counted, window id carries length', () => {
  const line = (step) => JSON.stringify({ timestamp: new Date(T + step * 1000).toISOString(), type: 'event_msg', payload: { type: 'token_count',
    info: { total_token_usage: { input_tokens: 1000 * step, cached_input_tokens: 600 * step, output_tokens: 100 * step, reasoning_output_tokens: 40 * step },
      last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, output_tokens: 100, reasoning_output_tokens: 40 } },
    rate_limits: { plan_type: 'pro', primary: { used_percent: 33, window_minutes: 10080, resets_at: 1793082726 }, secondary: null, rate_limit_reached_type: null } } });
  const text = [JSON.stringify({ type: 'turn_context', payload: { type: 'turn_context', model: 'gpt-6-luna', effort: 'low' } }), line(1), line(2), 'not json'].join('\n');
  const out = parseCodexRollout(text);
  assert.equal(out.model, 'gpt-6-luna'); assert.equal(out.effort, 'low'); assert.equal(out.plan_type, 'pro');
  assert.deepEqual(out.tokens, { fresh_input: 800, cache_read: 1200, cache_write_5m: 0, cache_write_1h: 0, output: 200, reasoning: 80 });
  assert.equal(out.readings[0].window_id, 'codex:10080'); assert.equal(out.readings[0].used_pct, 33);
  assert.equal(new Date(out.readings[0].resets_at).toISOString(), '2026-10-27T06:32:06.000Z');
  assert.equal(out.calls.length, 2);
});

test('usage GET parsers (Phase 0 shapes, clawmeter fixtures): percent units, scoped windows, limit flags', () => {
  const c = parseClaudeUsage({ five_hour: { utilization: 25, resets_at: '2026-10-20T16:19:59.550398Z' }, seven_day: { utilization: 37, resets_at: '2026-10-23T01:59:59.550422Z' },
    seven_day_opus: null, extra_usage: { is_enabled: false }, limits: [{ kind: 'weekly_all', percent: 99, resets_at: '2026-10-23T02:00:00Z' }] }, T);
  assert.deepEqual(c.readings.map(r => [r.window_id, r.used_pct, r.source]), [['five_hour', 25, 'probe'], ['seven_day', 37, 'probe']]);
  assert.equal(c.extra_usage_enabled, false);
  const fromLimits = parseClaudeUsage({ limits: [{ kind: 'session', percent: 12, resets_at: '2026-10-20T16:20:00Z' }] }, T);
  assert.equal(fromLimits.readings[0].window_id, 'five_hour');
  const x = parseCodexUsage({ plan_type: 'pro', rate_limit: { allowed: true, limit_reached: false,
    primary_window: { used_percent: 47, limit_window_seconds: 604800, reset_at: 1793082726 }, secondary_window: null } }, T);
  assert.deepEqual(x.readings.map(r => [r.window_id, r.window_minutes, r.used_pct]), [['codex:10080', 10080, 47]]);
  assert.equal(x.limit_reached, false);
  assert.equal(parseCodexUsage({ rate_limit: { allowed: false } }, T).limit_reached, true);
  const after = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 12, limit_window_seconds: 18000, reset_after_seconds: 3600 } } }, T);
  assert.equal(after.readings[0].resets_at, T + 3600000);
  assert.equal(parseCodexUsage({}, T), null);
});

test('L131: Lend shows not started, never a percentage, for a provider five-hour window that is not open', () => {
  for (const provider of ['claude', 'codex']) for (const admitted of [true, false]) {
    const parsed = provider === 'claude'
      ? parseClaudeUsage({ five_hour: { utilization: 0, resets_at: null },
        seven_day: { utilization: 20, resets_at: T + 86400000 } }, T)
      : parseCodexUsage({ rate_limit: { primary_window: { used_percent: 0, limit_window_seconds: 18000, reset_at: null },
        secondary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: T + 86400000 } } }, T);
    const short = parsed.readings.find(w => w.window_minutes === 300);
    const week = parsed.readings.find(w => w.window_minutes === 10080);
    assert.equal(short.state, 'not_open');
    const account = { provider, decision: { windows: parsed.readings, availability: { admitted,
      status: { line: 'Waiting for a request.' }, objective: { lendablePoints: { [short.window_id]: 97.5, [week.window_id]: 42 } } } } };
    const lines = lendingQuotaLinesVM({ accounts: [account] }, false, { lending: { intent: 'on' } });
    if (admitted) {
      assert.equal(lines.find(line => line.key.endsWith('/' + short.window_id)).text, 'not started');
      assert.equal(lines.find(line => line.key.endsWith('/' + week.window_id)).text, "About 42% of this week's quota is open to lend now.");
    } else {
      assert.equal(lines.length, 1);
      assert.equal(lines[0].text, 'Waiting for a request. This 5-hour window: not started. This week: about 42%.');
    }
    if (provider === 'claude') {
      account.decision.windows = parseClaudeUsage({ five_hour: null,
        seven_day: { utilization: 20, resets_at: T + 86400000 } }, T).readings;
      const nullLines = lendingQuotaLinesVM({ accounts: [account] }, false, { lending: { intent: 'on' } });
      assert.equal(nullLines.find(line => line.key.endsWith('/five_hour'))?.text ?? nullLines[0].text,
        admitted ? 'not started' : 'Waiting for a request. This week: about 42%. This 5-hour window: not started.');
    }
    short.state = 'open'; short.resets_at = T + 3600000;
    account.decision.windows = parsed.readings;
    const openLines = lendingQuotaLinesVM({ accounts: [account] }, false, { lending: { intent: 'on' } });
    assert.match(openLines.find(line => line.key.endsWith('/' + short.window_id))?.text ?? openLines[0].text, /97\.5%/);
  }
});

test('L131: Lend omits an absent provider five-hour window even if objective points still contain it', () => {
  for (const provider of ['claude', 'codex']) for (const admitted of [true, false]) {
    const parsed = provider === 'claude'
      ? parseClaudeUsage({ seven_day: { utilization: 20, resets_at: T + 86400000 } }, T)
      : parseCodexUsage({ rate_limit: { primary_window: { used_percent: 20, limit_window_seconds: 604800, reset_at: T + 86400000 } } }, T);
    const week = parsed.readings[0], shortId = provider === 'claude' ? 'five_hour' : 'codex:300';
    assert.equal(parsed.readings.length, 1);
    const lines = lendingQuotaLinesVM({ accounts: [{ provider, decision: { windows: parsed.readings,
      availability: { admitted, status: { line: 'Waiting for a request.' },
        objective: { lendablePoints: { [week.window_id]: 42, [shortId]: 97.5 } } } } }] }, false, { lending: { intent: 'on' } });
    assert.equal(lines.length, 1);
    assert.equal(lines[0].label, (provider === 'claude' ? 'Claude Code' : 'Codex') + ' · this week');
    assert.equal(lines[0].text, admitted ? "About 42% of this week's quota is open to lend now." : 'Waiting for a request.');
    assert.doesNotMatch(lines[0].label + ' ' + lines[0].text, /5-hour|97\.5%/);
  }
});

test('guard meter lines are validated; guard usage normalizes to meter classes', () => {
  const line = JSON.stringify({ type: 'faravan.meter', v: 1, at: new Date(T).toISOString(), model: 'gpt-6-luna', tokens: { input: 1000, cached_input: 600, output: 100, reasoning_output: 40 },
    windows: [{ window_id: 'codex:10080', window_minutes: 10080, used_pct: 33, resets_at: '2026-10-27T06:32:06.000Z' }, { window_id: 'BAD ID', window_minutes: 1, used_pct: 1 }] });
  const out = parseGuardMeterLine(line);
  assert.equal(out.readings.length, 1); assert.equal(out.readings[0].observed_at, T);
  assert.equal(parseGuardMeterLine('{"type":"faravan.heartbeat"}'), null);
  assert.deepEqual(normalizeGuardUsage('codex', out.tokens), { fresh_input: 400, cache_read: 600, cache_write_5m: 0, cache_write_1h: 0, output: 100, reasoning: 40 });
  assert.deepEqual(normalizeGuardUsage('claude', { input: 8, cached_input: 30879, cache_write: 1177, output: 128 }),
    { fresh_input: 8, cache_read: 30879, cache_write_5m: 0, cache_write_1h: 1177, output: 128, reasoning: 0 });
});

test('list pricer: 1h cache write rate, above-threshold tier per call, reasoning not double counted, unpriced', () => {
  const tokens = { ...emptyTokens(), fresh_input: 1e6, cache_write_1h: 1e6, cache_write_5m: 1e6, cache_read: 1e6, output: 1e6, reasoning: 5e5 };
  const opus = priceListUsd('claude-opus-5-5', tokens);
  assert.equal(opus.usd, 4 + 8 + 5 + 0.2 + 20);
  assert.equal(opus.list_usd_micros, 37200000);
  assert.equal(priceListUsd('claude-haiku-4-5-20251001', { ...emptyTokens(), output: 1e6 }).model_key, 'claude-haiku-4-5-20251001');
  const small = priceListUsd('gpt-6-sol', { ...emptyTokens(), fresh_input: 1e6 }, { calls: [{ ...emptyTokens(), fresh_input: 1e6, prompt: 1000 }] });
  const large = priceListUsd('gpt-6-sol', { ...emptyTokens(), fresh_input: 1e6 }, { calls: [{ ...emptyTokens(), fresh_input: 1e6, prompt: 300000 }] });
  assert.equal(small.usd, 2); assert.equal(large.usd, 4);
  assert.equal(priceListUsd('mystery-model', tokens).priced, false);
  assert.match(PRICE_CATALOG.list_usd_rev, /^prices-sha256:[0-9a-f]{64}$/);
});

test('Codex credits: official card, fast 2.5x, family match, other speeds unpriced', () => {
  const t = { ...emptyTokens(), fresh_input: 1e6, cache_read: 1e6, output: 1e6, reasoning: 1e6 };
  assert.equal(priceCodexCredits('gpt-6-sol', t).credits, 50 + 5 + 250);
  assert.equal(priceCodexCredits('gpt-6-sol', t, { speed: 'fast' }).credits, 2.5 * 305);
  assert.equal(priceCodexCredits('gpt-5.6-codex', t).model_key, 'gpt-5.6-sol');
  assert.equal(priceCodexCredits('gpt-6-sol', t, { speed: 'ultra' }).priced, false);
  assert.equal(modelFamily('codex', 'gpt-6.1-sol'), 'gpt-6'); assert.equal(modelFamily('codex', 'gpt-5.5'), 'gpt-5');
});

test('meterJob: Claude unit is Claude Code cost; Codex unit is credits; public receipt is integers without account data', () => {
  const claude = meterJob({ provider: 'claude', model: 'claude-haiku-4-5-20251001', tokens: { ...emptyTokens(), output: 1000 }, cost_usd: 0.05 });
  assert.equal(claude.unit, 'claude_usd'); assert.equal(claude.priced_units, 0.05); assert.equal(claude.cost_basis, 'claude_code_list');
  const codex = meterJob({ provider: 'codex', model: 'gpt-6-luna', tokens: { ...emptyTokens(), fresh_input: 1e6 } });
  assert.equal(codex.unit, 'codex_credits'); assert.equal(codex.priced_units, 2.5);
  const receipt = publicBudgetReceipt(codex, { effort: 'low', stop_reason: 'budget' });
  assert.deepEqual(Object.keys(receipt).sort(), ['catalog_rev', 'effort', 'list_usd_micros', 'model', 'stop_reason', 'tokens']);
  for (const v of [...Object.values(receipt.tokens), receipt.list_usd_micros]) assert.ok(Number.isSafeInteger(v));
  assert.throws(() => publicBudgetReceipt(codex, { stop_reason: 'whatever' }));
});

// Real artifact run (real-route qualification 1023): provider usage input 2, output 259, cache read 11236, cache write
// 18154, provider total_cost_usd 0.00387286. The guard emits the wire keys below for the same usage.
const ARTIFACT_EMITTED = { input: 2, cached_input: 11236, cache_write: 18154, output: 259, reasoning_output: 0 };
const ARTIFACT_LIST_MICROS = 3873;

test('guard-emitted Claude tokens are refused by the pricer, never priced as zero; the one mapping prices them to the provider cost', () => {
  // Before the fix, meterJob priced only `output` (259 x $0.5/M = $0.0001295), about 30x under the provider cost.
  assert.throws(() => meterJob({ provider: 'claude', model: 'claude-haiku-5-5', tokens: ARTIFACT_EMITTED }), /unknown token key "input"/);
  assert.throws(() => priceListUsd('claude-haiku-5-5', { ...emptyTokens(), cache_wrte: 5 }), /unknown token key "cache_wrte"/);
  assert.throws(() => normalizeGuardUsage('claude', { fresh_input: 2 }), /unknown token key "fresh_input"/);
  const mapped = meterJob({ provider: 'claude', model: 'claude-haiku-5-5', tokens: normalizeGuardUsage('claude', ARTIFACT_EMITTED) });
  assert.equal(mapped.list_usd_micros, ARTIFACT_LIST_MICROS);
});

test('Claude usage without the 5m/1h split prices its cache writes at 1h, the rate Claude Code writes them at', () => {
  const stream = JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', usage: {
    input_tokens: 2, output_tokens: 259, cache_read_input_tokens: 11236, cache_creation_input_tokens: 18154 } } });
  const parsed = parseClaudeStream(stream);
  assert.deepEqual([parsed.tokens.cache_write_5m, parsed.tokens.cache_write_1h], [0, 18154]);
  assert.equal(meterJob({ provider: 'claude', model: parsed.model, tokens: parsed.tokens, calls: parsed.calls }).list_usd_micros, ARTIFACT_LIST_MICROS);
});

test('priceListUsd and jobUsage refuse a foreign key even beside calls, and calls must add up to the aggregate', () => {
  assert.throws(() => priceListUsd('claude-haiku-5-5', { input: 100 }, { calls: [{ ...emptyTokens(), output: 1, prompt: 100 }] }), /unknown token key "input"/);
  assert.throws(() => priceListUsd('claude-haiku-5-5', { ...emptyTokens(), output: 259 }, { calls: [{ ...emptyTokens(), prompt: 0 }] }), /do not add up/);
  assert.throws(() => jobUsage({ provider: 'claude', stream: { tokens: { input: 100 }, calls: null } }), /unknown token key "input"/);
});

test('worstCallUsd: the most one call can cost at the prompt sizes it can reach; Haiku 5.5 is priced at its higher tier above 100k', async () => {
  const { worstCallUsd } = await import('../lib/v1/lending-meter.mjs');
  const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} is not ${expected}`);
  near(worstCallUsd('claude-haiku-5-5', { maxPromptTokens: 1_000_000, maxOutputTokens: 128_000 }), 1.32);
  near(worstCallUsd('claude-haiku-5-5', { maxPromptTokens: 100_000, maxOutputTokens: 128_000 }), 0.084);
  near(worstCallUsd('claude-opus-5-5', { maxPromptTokens: 1_000_000, maxOutputTokens: 128_000 }), 10.56);
  assert.equal(worstCallUsd('mystery-model', { maxPromptTokens: 1000, maxOutputTokens: 1 }), null);
});

test('a cache_creation object without an explicit 1h count prices its writes at 1h; an explicit 1h count of zero is the split', () => {
  const usage = { input_tokens: 2, output_tokens: 259, cache_read_input_tokens: 11236, cache_creation_input_tokens: 18154 };
  const streamWith = cache_creation => parseClaudeStream(JSON.stringify({ type: 'assistant', message: { id: 'm1', model: 'claude-haiku-5-5', usage: { ...usage, cache_creation } } }));
  const bare = streamWith({});
  assert.deepEqual([bare.tokens.cache_write_5m, bare.tokens.cache_write_1h], [0, 18154]);
  const explicit = streamWith({ ephemeral_5m_input_tokens: 18154, ephemeral_1h_input_tokens: 0 });
  assert.deepEqual([explicit.tokens.cache_write_5m, explicit.tokens.cache_write_1h], [18154, 0]);
});

test('Codex fractional window minutes retain their provider id and duration', () => {
  const out = parseCodexRateLimits({primary: {window_minutes: 300.5, used_percent: 10, resets_at: T / 1000 + 3600}}, T);
  assert.equal(out.readings[0].window_id, 'codex:300.5');
  assert.equal(out.readings[0].window_minutes, 300.5);
});
