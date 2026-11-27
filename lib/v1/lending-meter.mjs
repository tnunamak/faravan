/**
 * Lending meter: parsers and pricers for lent-account readings and job usage (LENDING-POLICY-DESIGN.md D2, D3, D8).
 * No I/O, clock, or credential access. Pricing uses the selected catalog; token inputs are validated.
 *
 * Reading  {window_id, window_minutes, used_pct, resets_at (ms), observed_at (ms), state: open|not_open|unknown, source}
 * Tokens   {fresh_input, cache_read, cache_write_5m, cache_write_1h, output, reasoning}  (non-negative integers)
 *          `reasoning` is the part of `output` that was reasoning; it is never priced twice.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import {mergeListPrices, validPriceRow, contextPriceTiers, priceTierFor, lookupPriceRow as lookup} from './litellm-prices.mjs';

const PRICES = createRequire(import.meta.url)('./lending-prices.json');
const pinnedModels = PRICES.list_usd.models;
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export const priceCatalogRevision = data => 'prices-sha256:' + createHash('sha256').update(JSON.stringify(canonical(data))).digest('hex');
const priceScope = new AsyncLocalStorage();
export const currentPriceCatalog = () => priceScope.getStore() ?? effective;
export const withPriceCatalog = (catalog, fn) => priceScope.run(catalog, fn);
export function effectivePriceCatalog(models = {}) {
  const data = canonical({list_usd: mergeListPrices(pinnedModels, models), codex_credits: PRICES.codex_credits});
  const revision = priceCatalogRevision(data);
  return {revision, data};
}
export function validPriceCatalog(data) {
  if (!data || !data.list_usd || typeof data.list_usd !== 'object' || Array.isArray(data.list_usd) ||
      !Object.values(data.list_usd).every(validPriceRow)) return false;
  const card = data.codex_credits;
  if (!card || !card.models || typeof card.models !== 'object' || Array.isArray(card.models) ||
      !Array.isArray(card.match) || !card.speed_multipliers || typeof card.speed_multipliers !== 'object') return false;
  const rate = value => Number.isFinite(value) && value > 0 && value <= 25000;
  if (!Object.values(card.models).every(row => row && ['fresh_input_per_m', 'cache_read_per_m', 'output_per_m'].every(key => rate(row[key])) &&
      Object.entries(row).every(([key, value]) => !key.endsWith('_per_m') || (Number.isFinite(value) && value >= 0 && value <= 25000))) ||
      !card.match.every(match => match && typeof match.pattern === 'string' && match.pattern.length > 0 &&
        typeof match.model === 'string' && Object.hasOwn(card.models, match.model)) ||
      !Object.values(card.speed_multipliers).every(value => Number.isFinite(value) && value > 0 && value <= 10) ||
      !Number.isFinite(card.speed_multipliers.standard)) return false;
  return Object.keys(data.list_usd).length > 0;
}
let effective = effectivePriceCatalog();
export const PRICE_CATALOG = {
  list_usd_rev: effective.revision,
  codex_credits_rev: effective.revision,
};
export function setLiveListPrices(models) {
  effective = effectivePriceCatalog(models);
  PRICE_CATALOG.list_usd_rev = effective.revision;
  PRICE_CATALOG.codex_credits_rev = effective.revision;
}


const CLAUDE_WINDOW_MINUTES = { five_hour: 300, seven_day: 10080, seven_day_opus: 10080, seven_day_sonnet: 10080,
  seven_day_oauth_apps: 10080, seven_day_overage_included: 10080 };
const count = v => Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
const pct = v => Number.isFinite(v) && v >= 0 && v <= 100 ? Math.round(v * 1000) / 1000 : null;
const ms = v => typeof v === 'number' ? (v > 0 && v < 1e11 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) : NaN;
const okId = id => typeof id === 'string' && /^[a-z0-9_:.-]{1,60}$/.test(id);
export const emptyTokens = () => ({ fresh_input: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: 0, reasoning: 0 });

// Two vocabularies, one mapping. The guard's wire keys (lib/faravan-guard.mjs emits them, lib/faravan-guard-host.mjs
// parses them) are not the pricing keys. normalizeGuardUsage is the only translation between them. Pricing and translation
// both refuse a key from the other vocabulary: a wrong key is a loud error, never a zero.
export const GUARD_TOKEN_KEYS = Object.freeze(['input', 'cached_input', 'cache_write', 'output', 'reasoning_output']);
const METER_TOKEN_KEYS = Object.freeze(['fresh_input', 'cache_read', 'cache_write_5m', 'cache_write_1h', 'output', 'reasoning']);
const CALL_KEYS = Object.freeze([...METER_TOKEN_KEYS, 'prompt']);
function checkTokens(tokens, keys, where) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) throw new TypeError(`${where}: expected a token object`);
  for (const [key, value] of Object.entries(tokens)) {
    if (!keys.includes(key)) throw new TypeError(`${where}: unknown token key "${key}"`);
    if (!Number.isFinite(value) || value < 0) throw new TypeError(`${where}: token "${key}" is not a non-negative number`);
  }
  return tokens;
}
const meterTokens = (tokens, where) => ({ ...emptyTokens(), ...checkTokens(tokens, METER_TOKEN_KEYS, where) });

// `not_open` needs explicit, fresh probe evidence: a probe that reports nothing used and no reset instant
// (Codex weekly-from-first-use). Any other missing or past reset is `unknown`, never `not_open` (D2 reading model).
function reading(window_id, window_minutes, used, reset, observedAt, source) {
  const used_pct = pct(used), resets_at = ms(reset);
  if (!okId(window_id) || !Number.isFinite(window_minutes) || window_minutes <= 0 || used_pct === null || !Number.isFinite(observedAt)) return null;
  if (!Number.isFinite(resets_at)) return source === 'probe' && used_pct === 0
    ? { window_id, window_minutes, used_pct: 0, resets_at: null, observed_at: observedAt, state: 'not_open', source } : null;
  return { window_id, window_minutes, used_pct, resets_at, observed_at: observedAt, state: resets_at > observedAt ? 'open' : 'unknown', source };
}

/** Claude stream `rate_limit_event.rate_limit_info`. Utilization is a 0..1 fraction (Phase 0, Claude Code 2.1.280). */
export function parseClaudeRateLimit(info, observedAt) {
  if (!info || typeof info !== 'object') return null;
  const readings = [];
  for (const [id, entry] of Object.entries(info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows : {})) {
    const r = entry && reading(id, CLAUDE_WINDOW_MINUTES[id] ?? NaN, entry.utilization * 100, entry.resetsAt, observedAt, 'inband');
    if (r) readings.push(r);
  }
  return { readings, status: typeof info.status === 'string' ? info.status.slice(0, 40) : null,
    using_overage: info.isUsingOverage === true, limit_reached: info.status === 'rejected',
    overage_would_bill: info.isUsingOverage === true || info.overageStatus === 'allowed' };
}

/**
 * Claude Code `--output-format stream-json` (one JSON object per line). Assistant messages repeat once per
 * content block with the same id and usage, so usage is keyed by message id. `cost_usd` is Claude Code's own
 * list-price total, the Claude priced unit (D3). Consumers must check `is_error`, not `subtype` (Phase 0 probe 4).
 */
export function parseClaudeStream(text, { observedAt = NaN } = {}) {
  const messages = new Map(), readings = [];
  const out = { provider: 'claude', model: null, harness_version: null, tokens: emptyTokens(), cost_usd: null, readings,
    result: null, limit_reached: false, using_overage: false };
  for (const line of String(text).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e?.type === 'system' && e.subtype === 'init') {
      if (typeof e.model === 'string') out.model = e.model.slice(0, 80);
      if (typeof e.claude_code_version === 'string') out.harness_version = e.claude_code_version.slice(0, 40);
    } else if (e?.type === 'rate_limit_event') {
      const at = Number.isFinite(observedAt) ? observedAt : ms(e.observed_at);
      const r = parseClaudeRateLimit(e.rate_limit_info, at);
      if (r) { readings.push(...r.readings); out.limit_reached ||= r.limit_reached; out.using_overage ||= r.using_overage; }
    } else if (e?.type === 'assistant' && e.message?.usage) {
      const u = e.message.usage, c = u.cache_creation;
      if (typeof e.message.model === 'string') out.model = e.message.model.slice(0, 80);
      // Claude Code writes 1-hour cache. A write without an explicit 1h count is priced at 1h, the higher rate (D3).
      const write = count(u.cache_creation_input_tokens);
      const h1 = Number.isFinite(c?.ephemeral_1h_input_tokens) ? Math.min(write, count(c.ephemeral_1h_input_tokens)) : write;
      messages.set(String(e.message.id ?? messages.size), { fresh_input: count(u.input_tokens), cache_read: count(u.cache_read_input_tokens),
        cache_write_1h: h1, cache_write_5m: write - h1,
        output: count(u.output_tokens), reasoning: 0, prompt: count(u.input_tokens) + count(u.cache_read_input_tokens) + write });
    } else if (e?.type === 'result') {
      if (Number.isFinite(e.total_cost_usd) && e.total_cost_usd >= 0) out.cost_usd = e.total_cost_usd;
      out.result = { subtype: typeof e.subtype === 'string' ? e.subtype.slice(0, 60) : null, is_error: e.is_error === true,
        budget_stop: e.subtype === 'error_max_budget_usd', num_turns: count(e.num_turns) };
    }
  }
  out.calls = [...messages.values()];
  for (const m of out.calls) for (const k of Object.keys(out.tokens)) out.tokens[k] += m[k];
  return out;
}

/** Codex `rate_limits` (rollout token_count). `primary` is not "five hours": the id carries the window length (D2). */
export function parseCodexRateLimits(limits, observedAt, source = 'inband') {
  if (!limits || typeof limits !== 'object') return null;
  const readings = [];
  for (const key of ['primary', 'secondary']) {
    const w = limits[key];
    const minutes = w?.window_minutes;
    const r = w && reading('codex:' + minutes, minutes, w.used_percent, w.resets_at, observedAt, source);
    if (r) readings.push(r);
  }
  const rejected = Boolean(limits.rate_limit_reached_type) || limits.spend_control_reached === true;
  const clear = limits.rate_limit_reached_type === null && limits.spend_control_reached === false;
  return { readings, limit_reached: rejected ? true : clear ? false : undefined,
    plan_type: typeof limits.plan_type === 'string' ? limits.plan_type.slice(0, 20) : null };
}

/**
 * Codex rollout JSONL (`~/.codex/sessions/.../rollout-*.jsonl` inside the guest, copied out or tailed by the guard).
 * `total_token_usage` is cumulative; OpenAI `input_tokens` includes `cached_input_tokens`, and `output_tokens`
 * includes `reasoning_output_tokens`.
 */
export function parseCodexRollout(text) {
  const out = { provider: 'codex', model: null, effort: null, tokens: emptyTokens(), readings: [], limit_reached: undefined, plan_type: null, calls: [] };
  let sawLimit = false;
  for (const line of String(text).split('\n')) {
    let rec; try { rec = JSON.parse(line); } catch { continue; }
    const p = rec?.payload ?? rec, at = ms(rec?.timestamp);
    if (p?.type === 'turn_context') {
      if (typeof p.model === 'string') out.model = p.model.slice(0, 80);
      if (typeof p.effort === 'string') out.effort = p.effort.slice(0, 20);
    }
    if (p?.type !== 'token_count') continue;
    const t = p.info?.total_token_usage, last = p.info?.last_token_usage;
    if (t) out.tokens = codexTokens(t);
    if (last) out.calls.push({ ...codexTokens(last), prompt: count(last.input_tokens) });
    const r = parseCodexRateLimits(p.rate_limits, at);
    // Rejection wins; otherwise every token-count observation must affirmatively be clear.
    // A later clear record cannot erase an unknown record from this run.
    const verdict = r?.limit_reached;
    out.limit_reached = out.limit_reached === true || verdict === true ? true
      : verdict === false && (!sawLimit || out.limit_reached === false) ? false : undefined;
    sawLimit = true;
    if (r) { out.readings.push(...r.readings); out.plan_type = r.plan_type ?? out.plan_type; }
  }
  return out;
}
function codexTokens(t) {
  const input = count(t.input_tokens), cached = Math.min(input, count(t.cached_input_tokens));
  const output = count(t.output_tokens);
  return { fresh_input: input - cached, cache_read: cached, cache_write_5m: 0, cache_write_1h: 0, output, reasoning: Math.min(output, count(t.reasoning_output_tokens)) };
}

/**
 * Guard meter `tokens` ({input, cached_input, cache_write, output, reasoning_output}; lib/faravan-guard.mjs) to meter Tokens.
 * Codex `input` includes `cached_input`. The guard does not split Claude cache writes by TTL; they are taken as 1-hour
 * writes (what Claude Code writes, and the higher price). For the exact 5m/1h split, parse the job's Claude stdout
 * with parseClaudeStream, which keeps it.
 */
export function normalizeGuardUsage(provider, t = {}) {
  checkTokens(t, GUARD_TOKEN_KEYS, 'guard tokens');
  const input = count(t.input), cached = count(t.cached_input), output = count(t.output);
  const reasoning = Math.min(output, count(t.reasoning_output));
  if (provider === 'codex') return { fresh_input: input - Math.min(input, cached), cache_read: Math.min(input, cached), cache_write_5m: 0, cache_write_1h: 0, output, reasoning };
  return { fresh_input: input, cache_read: cached, cache_write_5m: 0, cache_write_1h: count(t.cache_write), output, reasoning };
}

/** A `faravan.meter` line from lib/faravan-guard.mjs (stderr). Untrusted: only windows are taken. */
export function parseGuardMeterLine(line) {
  let e; try { e = JSON.parse(line); } catch { return null; }
  if (e?.type !== 'faravan.meter' || e.v !== 1 || !Array.isArray(e.windows)) return null;
  const at = ms(e.at), readings = [];
  for (const w of e.windows.slice(0, 16)) { const r = w && reading(w.window_id, w.window_minutes, w.used_pct, w.resets_at, at, 'inband'); if (r) readings.push(r); }
  return { readings, limit_reached: typeof e.limit_reached === 'boolean' ? e.limit_reached : undefined, using_overage: e.overage === true,
    tokens: e.tokens && typeof e.tokens === 'object' ? e.tokens : null, model: typeof e.model === 'string' ? e.model.slice(0, 80) : null,
    cost_usd: Number.isFinite(e.cost_usd) && e.cost_usd >= 0 ? e.cost_usd : null, final: e.final === true };
}

/** Claude `GET api.anthropic.com/api/oauth/usage` body. Utilization is a 0..100 percent (Phase 0 probe 2; clawmeter anthropic.go). */
export function parseClaudeUsage(body, observedAt) {
  if (!body || typeof body !== 'object') return null;
  const readings = [], seen = new Set();
  for (const id of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet', 'seven_day_oauth_apps']) {
    const w = body[id];
    const r = w && typeof w === 'object' && reading(id, CLAUDE_WINDOW_MINUTES[id], w.utilization, w.resets_at, observedAt, 'probe');
    if (r) { readings.push(r); seen.add(id); }
  }
  for (const l of Array.isArray(body.limits) ? body.limits.slice(0, 32) : []) {
    const id = l?.kind === 'session' ? 'five_hour' : l?.kind === 'weekly_all' ? 'seven_day' : null;
    if (!id || seen.has(id)) continue;
    const r = reading(id, CLAUDE_WINDOW_MINUTES[id], l.percent, l.resets_at, observedAt, 'probe');
    if (r) { readings.push(r); seen.add(id); }
  }
  // With no five-hour session open, the reply sends `"five_hour": null` and no session limit (seen live 2026-11-01; it used to
  // send zero use and no reset). The provider is saying the window is not open. A missing key stays unread.
  if (body.five_hour === null && !seen.has('five_hour')) readings.push(reading('five_hour', CLAUDE_WINDOW_MINUTES.five_hour, 0, null, observedAt, 'probe'));
  return { readings, extra_usage_enabled: body.extra_usage?.is_enabled === true, extra_usage_state: extraUsageState(body) };
}

// The provider's own extra-usage reading, kept as presence. An absent or malformed field is not a disabled reading,
// so the boolean above (which coerces absent to false) must never stand in for the funding fact.
function extraUsageState(body) {
  const extra = body.extra_usage;
  if (extra === undefined) return 'absent';
  if (!extra || typeof extra !== 'object' || typeof extra.is_enabled !== 'boolean') return 'invalid';
  return extra.is_enabled ? 'enabled' : 'disabled';
}

/** Codex `GET chatgpt.com/backend-api/wham/usage` body (clawmeter openai/direct_usage.go). */
export function parseCodexUsage(body, observedAt, { preserveUnknownLimit = false } = {}) {
  const rl = body?.rate_limit;
  if (!rl || typeof rl !== 'object') return null;
  const readings = [];
  for (const key of ['primary_window', 'secondary_window']) {
    const w = rl[key];
    if (w === null || w === undefined) continue;
    if (typeof w !== 'object' || Array.isArray(w) || !Number.isFinite(w.limit_window_seconds)) return null;
    const r = reading('codex:' + Math.round(w.limit_window_seconds / 60), Math.round(w.limit_window_seconds / 60), w.used_percent,
      w.reset_at ?? (Number.isFinite(w.reset_after_seconds) ? observedAt + w.reset_after_seconds * 1000 : null), observedAt, 'probe');
    if (!r) return null; // Present but unreadable is not an absent window.
    readings.push(r);
  }
  const rejected = rl.limit_reached === true || rl.allowed === false || body.spend_control?.reached === true;
  // Preserve the legacy summary API, but safety callers need three-valued evidence.
  // A negative on only one cause cannot clear a hold caused by another unknown cause.
  const recovered = rl.limit_reached === false && rl.allowed === true && body.spend_control?.reached === false;
  const verdict = rejected ? true : recovered ? false : undefined;
  return { readings, limit_reached: preserveUnknownLimit ? verdict : rejected,
    has_credits: body.credits?.has_credits === true, plan_type: typeof body.plan_type === 'string' ? body.plan_type.slice(0, 20) : null };
}

/** The priced row for a model id, as [catalog key, row], or null. Admission and pricing share this lookup. */
export const priceRowFor = (model, catalog = currentPriceCatalog()) => lookup(catalog.data.list_usd, model);

/**
 * List-price USD from the effective LiteLLM table (display, and harnesses that report no cost; D8).
 * `calls` (per-request prompt sizes) select the above-threshold tier per request; without them the base tier is used.
 */
export function priceListUsd(model, tokens, { calls = null, speed = 'standard', catalog = currentPriceCatalog() } = {}) {
  const aggregate = meterTokens(tokens, 'tokens');
  const hasCalls = Array.isArray(calls) && calls.length > 0;
  const parts = hasCalls
    ? calls.map((c, i) => ({ ...emptyTokens(), ...checkTokens(c, CALL_KEYS, `calls[${i}]`) }))
    : [{ ...aggregate, prompt: 0 }];
  // Calls are the priced unit when present, so they must account for every aggregate token: a gap would price zero.
  if (hasCalls) for (const key of METER_TOKEN_KEYS) {
    const sum = parts.reduce((s, c) => s + c[key], 0);
    if (sum !== aggregate[key]) throw new TypeError(`calls do not add up to the tokens: ${key} is ${sum} in calls, ${aggregate[key]} in tokens`);
  }
  const hit = lookup(catalog.data.list_usd, model);
  if (!hit) return { priced: false, usd: null, list_usd_micros: null, catalog_rev: catalog.revision };
  const [key, row] = hit;
  const tierFor = prompt => priceTierFor(row, prompt, speed);
  const cost = (t, k) => k.fresh_input * t.fresh_input_per_m + k.cache_read * (t.cache_read_per_m ?? t.fresh_input_per_m) +
    k.cache_write_5m * (t.cache_write_5m_per_m ?? t.fresh_input_per_m) + k.cache_write_1h * (t.cache_write_1h_per_m ?? t.cache_write_5m_per_m ?? t.fresh_input_per_m) +
    k.output * t.output_per_m;
  if (!validPriceRow(row)) return { priced: false, usd: null, list_usd_micros: null, catalog_rev: catalog.revision };
  const usd = parts.reduce((s, c) => s + cost(tierFor(c.prompt ?? 0), c), 0) / 1e6;
  if (!Number.isFinite(usd) || (usd === 0 && parts.some(c => c.fresh_input > 0 || c.cache_read > 0 || c.cache_write_5m > 0 || c.cache_write_1h > 0 || c.output > 0)))
    return { priced: false, usd: null, list_usd_micros: null, catalog_rev: catalog.revision };
  return { priced: true, model_key: key, usd, list_usd_micros: Math.round(usd * 1e6), catalog_rev: catalog.revision };
}

/**
 * The most one call can cost, in list USD, when its prompt can be any size up to `maxPromptTokens` and its output up to
 * `maxOutputTokens`. The tier is chosen per call by prompt size, so each input class is priced at each tier the prompt can
 * reach: the base tier up to the threshold, and the higher tier above it. Null when the model is unpriced.
 */
// The model ids in the price list. The lendable set is derived from these, never typed in by hand.
export function pricedModelIds() {
  return Object.keys(currentPriceCatalog().data.list_usd);
}

// Published catalogs are replaced, not edited: effectivePriceCatalog canonicalizes a fresh
// merge, setLiveListPrices replaces it, and readPriceSnapshot parses a fresh object.
const worstCalls = new WeakMap(), claudeHeadrooms = new WeakMap();
export function worstCallUsd(model, { maxPromptTokens, maxOutputTokens }) {
  const catalog = currentPriceCatalog();
  // Keep unusual/invalid inputs on the original calculation path (including NaN).
  if (typeof model !== 'string' || !Number.isFinite(maxPromptTokens) || !Number.isFinite(maxOutputTokens))
    return calculateWorstCallUsd(model, maxPromptTokens, maxOutputTokens, catalog);
  let cache = worstCalls.get(catalog);
  if (!cache) worstCalls.set(catalog, cache = new Map());
  const key = JSON.stringify([model, maxPromptTokens, maxOutputTokens]);
  if (!cache.has(key)) cache.set(key, calculateWorstCallUsd(model, maxPromptTokens, maxOutputTokens, catalog));
  return cache.get(key);
}
function calculateWorstCallUsd(model, maxPromptTokens, maxOutputTokens, catalog) {
  const hit = lookup(catalog.data.list_usd, model);
  if (!hit) return null;
  const [, row] = hit;
  const prompts = new Set([maxPromptTokens,
    ...contextPriceTiers(row).flatMap(tier => [tier.threshold, tier.threshold + 1])
      .filter(prompt => prompt <= maxPromptTokens)]);
  let worst = 0;
  for (const prompt of prompts) for (const cls of ['fresh_input', 'cache_read', 'cache_write_5m', 'cache_write_1h']) {
    const tokens = { ...emptyTokens(), [cls]: prompt, output: maxOutputTokens };
    worst = Math.max(worst, priceListUsd(model, tokens, { catalog, calls: [{ ...tokens, prompt }] }).usd);
  }
  return worst;
}

// The most one Claude call can cost at a model's largest reachable prompt, with a full output. This is the one headroom: a lend's native
// cap is its limit less this, and the legacy manager and the pace50 candidate both read it here. Null when the model is unpriced.
const CLAUDE_MAX_OUTPUT_TOKENS = 128000;
export function claudeCallHeadroomUsd(model) {
  const catalog = currentPriceCatalog();
  let cache = claudeHeadrooms.get(catalog);
  if (!cache) claudeHeadrooms.set(catalog, cache = new Map());
  if (!cache.has(model)) {
    const hit = priceRowFor(model, catalog);
    cache.set(model, hit ? worstCallUsd(model, {maxPromptTokens: hit[1].max_input_tokens ?? 1000000, maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS}) : null);
  }
  return cache.get(model);
}

// The model a lent job runs when it names none. Admission prices such a job at this model.
export const DEFAULT_RUN_MODEL = Object.freeze({codex: 'gpt-6-sol', claude: 'claude-sonnet-5-5'});

/** Codex credits from the official rate card (the Codex priced unit, D3). Fast mode is 2.5x; other speeds are unpriced. */
export function priceCodexCredits(model, tokens, { speed = 'standard', catalog = currentPriceCatalog() } = {}) {
  const t = meterTokens(tokens, 'tokens');
  const card = catalog.data.codex_credits, mult = card.speed_multipliers[speed];
  let row = typeof model === 'string' ? card.models[model] : null, key = model;
  if (!row && typeof model === 'string') {
    const m = card.match.find(x => model === x.pattern || model.startsWith(x.pattern + '-') || model.startsWith(x.pattern + '.'));
    if (m) { row = card.models[m.model]; key = m.model; }
  }
  if (!Number.isFinite(mult)) return { priced: false, credits: null, catalog_rev: catalog.revision };
  if (!row) {
    const list = priceListUsd(model, t, {catalog});
    return list.priced ? { priced: true, model_key: list.model_key, credits: list.usd * 25 * mult,
      catalog_rev: list.catalog_rev, cost_basis: 'litellm_list_x25' }
      : { priced: false, credits: null, catalog_rev: list.catalog_rev };
  }
  const credits = mult * (t.fresh_input * row.fresh_input_per_m + t.cache_read * row.cache_read_per_m + t.output * row.output_per_m) / 1e6;
  return { priced: true, model_key: key, credits, catalog_rev: catalog.revision };
}

/** The κ family a model belongs to (calibration is per account x window x family, D3). */
export function modelFamily(provider, model) {
  if (provider === 'codex') return typeof model === 'string' && /^gpt-6/.test(model) ? 'gpt-6' : typeof model === 'string' && /^gpt-5/.test(model) ? 'gpt-5' : 'codex-other';
  return 'claude';
}

/**
 * The tokens one job is priced on. The stream's own usage wins when it has any: Claude keeps the exact 5m/1h split and
 * its per-call prompt sizes. Otherwise the guard's observed tokens, through the one mapping. With neither, no usage.
 */
export function jobUsage({ provider, stream = null, guardTokens = null }) {
  if (stream) checkTokens(stream.tokens, METER_TOKEN_KEYS, 'stream tokens');
  if (stream && METER_TOKEN_KEYS.some(k => stream.tokens[k] > 0)) return { tokens: stream.tokens, calls: stream.calls ?? null };
  if (guardTokens) return { tokens: normalizeGuardUsage(provider, guardTokens), calls: null };
  return { tokens: emptyTokens(), calls: null };
}

/**
 * One job's metered usage: tokens by class, the provider priced unit and list $ for display.
 * Claude priced unit = Claude Code's own cost_usd (what --max-budget-usd enforces), else the LiteLLM price.
 */
export function meterJob({ provider, model = null, tokens = emptyTokens(), cost_usd = null, calls = null, speed = 'standard', catalog = currentPriceCatalog() }) {
  const list = priceListUsd(model, tokens, { calls, speed, catalog });
  if (provider === 'codex') {
    const c = priceCodexCredits(model, tokens, { speed, catalog });
    return { provider, model, family: modelFamily(provider, model), tokens, unit: c.priced ? 'codex_credits' : 'unpriced', priced_units: c.credits, cost_basis: c.cost_basis ?? (c.priced ? 'codex_credits_card' : null),
      list_usd: list.usd, list_usd_micros: list.list_usd_micros, catalog_rev: c.priced ? c.catalog_rev : list.catalog_rev };
  }
  const own = Number.isFinite(cost_usd) && cost_usd >= 0;
  return { provider, model, family: modelFamily(provider, model), tokens, unit: own || list.priced ? 'claude_usd' : 'unpriced',
    priced_units: own ? cost_usd : list.usd, cost_basis: own ? 'claude_code_list' : list.priced ? 'litellm_list' : null,
    list_usd: list.usd, list_usd_micros: list.list_usd_micros, catalog_rev: list.catalog_rev };
}

/**
 * The lender-neutral public receipt extension (budget_v1, D3): integers only, no account or window data.
 */
export const STOP_REASONS = Object.freeze(['done', 'budget', 'time', 'owner', 'provider_limit', 'error']);
export function publicBudgetReceipt(metered, { effort = null, stop_reason = 'done' } = {}) {
  if (!STOP_REASONS.includes(stop_reason)) throw new Error('invalid_stop_reason');
  const t = metered.tokens;
  return { tokens: { fresh_input: count(t.fresh_input), cache_read: count(t.cache_read), cache_write_5m: count(t.cache_write_5m),
    cache_write_1h: count(t.cache_write_1h), output: count(t.output), reasoning: count(t.reasoning) },
  list_usd_micros: Number.isSafeInteger(metered.list_usd_micros) ? metered.list_usd_micros : null, catalog_rev: metered.catalog_rev,
  model: typeof metered.model === 'string' ? metered.model : null, effort: typeof effort === 'string' ? effort : null, stop_reason };
}
