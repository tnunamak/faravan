import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPriceRefresh, LITELLM_URL} from '../lib/v1/lending-price-refresh.mjs';
import {emptyTokens, meterJob, priceListUsd, setLiveListPrices} from '../lib/v1/lending-meter.mjs';

const input = {...emptyTokens(), fresh_input: 1_000_000};
const document = {'gpt-6.1-terra': {litellm_provider: 'openai', input_cost_per_token: 0.000002, output_cost_per_token: 0.000004}};

test('refresh caches valid rows, preserves pinned fallback, and records the effective catalog', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'live-prices-'));
  let calls = 0;
  const fetcher = async (url, options) => {
    calls++; assert.equal(url, LITELLM_URL); assert.deepEqual(options.headers, {'User-Agent': 'Faravan'});
    return {ok: true, json: async () => document};
  };
  try {
    const refresh = startPriceRefresh({directory, fetcher, now: () => 100000000});
    await refresh.flight; refresh.close();
    assert.equal(priceListUsd('gpt-6.1-terra', input).usd, 2);
    assert.equal(priceListUsd('gpt-6-sol', input).priced, true);
    const sol = meterJob({provider: 'codex', model: 'gpt-6.1-sol', tokens: input});
    assert.equal(sol.cost_basis, 'litellm_list_x25');
    assert.equal(sol.priced_units, 25 * priceListUsd('gpt-6.1-sol', input).usd);
    const metered = meterJob({provider: 'codex', model: 'gpt-6.1-terra', tokens: input});
    assert.equal(metered.priced_units, 50); assert.equal(metered.cost_basis, 'litellm_list_x25');
    const snapshot = JSON.parse(await readFile(join(directory, 'prices', metered.catalog_rev.replace(':', '-') + '.json')));
    assert.equal(snapshot.list_usd['gpt-6.1-terra'].fresh_input_per_m, 2);
    setLiveListPrices({});
    const restart = startPriceRefresh({directory, fetcher, now: () => 100001000});
    await restart.flight; restart.close();
    assert.equal(calls, 1); assert.equal(priceListUsd('gpt-6.1-terra', input).usd, 2);
    const invalid = startPriceRefresh({directory, now: () => 100000000 + 86400001, fetcher: async () => ({ok: true, json: async () => ({bad: true})})});
    await invalid.flight; invalid.close();
    assert.equal(priceListUsd('gpt-6.1-terra', input).usd, 2);
    const saved = JSON.parse(await readFile(join(directory, 'lending-prices-cache.json')));
    assert.deepEqual(saved.document, document);
  } finally { setLiveListPrices({}); await rm(directory, {recursive: true, force: true}); }
});

test('pruning retains referenced snapshots and the newest few', async () => {
  const {effectivePriceCatalog} = await import('../lib/v1/lending-meter.mjs');
  const {savePriceSnapshot, readPriceSnapshot, prunePriceSnapshots} = await import('../lib/v1/lending-price-store.mjs');
  const {utimesSync} = await import('node:fs');
  const directory = await mkdtemp(join(tmpdir(), 'price-prune-'));
  try {
    const snapshots = Array.from({length: 8}, (_, i) => effectivePriceCatalog({
      'gpt-6.1-terra': {provider: 'openai', fresh_input_per_m: i + 1, output_per_m: 2},
    }));
    snapshots.forEach((snapshot, i) => {
      savePriceSnapshot(directory, snapshot);
      const path = join(directory, 'prices', snapshot.revision.replace(':', '-') + '.json');
      utimesSync(path, i + 1, i + 1);
    });
    prunePriceSnapshots(directory, new Set([snapshots[0].revision]), 3);
    assert.equal(readPriceSnapshot(directory, snapshots[0].revision).revision, snapshots[0].revision);
    assert.throws(() => readPriceSnapshot(directory, snapshots[1].revision), /price_snapshot_missing/);
    assert.equal(readPriceSnapshot(directory, snapshots[7].revision).revision, snapshots[7].revision);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('release refresh updates the staged file online and retains it offline', async () => {
  const {spawnSync} = await import('node:child_process');
  const directory = await mkdtemp(join(tmpdir(), 'price-build-'));
  const target = join(directory, 'prices.json');
  const hook = join(directory, 'fetch-hook.mjs');
  const script = new URL('../scripts/refresh-lending-prices.mjs', import.meta.url).pathname;
  try {
    const initial = {list_usd: {models: {'pinned-model': {fresh_input_per_m: 1},
      'gpt-6-sol': {provider: 'openai', max_input_tokens: 922000, fresh_input_per_m: 2,
        cache_read_per_m: 0.2, output_per_m: 10}}}};
    await writeFile(target, JSON.stringify(initial));
    const fetched = {...document, 'gpt-6-sol': {litellm_provider: 'openai', input_cost_per_token: 0.000001,
      cache_read_input_token_cost: 0.0000001, output_cost_per_token: 0.000005}};
    await writeFile(hook, `globalThis.fetch = async () => ({ok: true, text: async () => ${JSON.stringify(JSON.stringify(fetched))}});`);
    let run = spawnSync(process.execPath, ['--import', hook, script, target]);
    assert.equal(run.status, 0);
    const updated = JSON.parse(await readFile(target, 'utf8'));
    assert.equal(updated.list_usd.models['gpt-6.1-terra'].fresh_input_per_m, 2);
    assert.ok(updated.list_usd.models['pinned-model']);
    assert.deepEqual(updated.list_usd.models['gpt-6-sol'], initial.list_usd.models['gpt-6-sol']);
    await writeFile(hook, 'globalThis.fetch = async () => { throw new Error("offline"); };');
    run = spawnSync(process.execPath, ['--import', hook, script, target]);
    assert.equal(run.status, 0);
    assert.deepEqual(JSON.parse(await readFile(target, 'utf8')), updated);
  } finally { await rm(directory, {recursive: true, force: true}); }
});

test('fetched context metadata cannot shrink pinned worst-call headroom', async () => {
  const {parseLiteLLM} = await import('../lib/v1/litellm-prices.mjs');
  const {claudeCallHeadroomUsd} = await import('../lib/v1/lending-meter.mjs');
  const model = 'claude-fable-5';
  const original = claudeCallHeadroomUsd(model);
  try {
    setLiveListPrices(parseLiteLLM({[model]: {litellm_provider: 'anthropic', input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00005, max_input_tokens: 0}}));
    assert.equal(original, 26.4);
    assert.equal(claudeCallHeadroomUsd(model), original);
    const newRow = parseLiteLLM({'claude-fable-99': {litellm_provider: 'anthropic', input_cost_per_token: 0.00001,
      output_cost_per_token: 0.00005, max_input_tokens: 0}})['claude-fable-99'];
    assert.equal(newRow.max_input_tokens, null);
  } finally { setLiveListPrices({}); }
});

test('valid increases apply field by field while pinned fallback rates and metadata stay safe', async () => {
  const {parseLiteLLM, mergeListPrices} = await import('../lib/v1/litellm-prices.mjs');
  const {currentPriceCatalog, priceCatalogRevision} = await import('../lib/v1/lending-meter.mjs');
  const {readPriceSnapshot} = await import('../lib/v1/lending-price-store.mjs');
  const model = 'gpt-6-sol', before = structuredClone(currentPriceCatalog().data.list_usd[model]);
  const directory = await mkdtemp(join(tmpdir(), 'lower-price-snapshot-'));
  try {
    setLiveListPrices(parseLiteLLM({[model]: {litellm_provider: 'openai', input_cost_per_token: 0.000003,
      cache_read_input_token_cost: 0.0000001, output_cost_per_token: 0.000015, max_input_tokens: 1}}));
    const row = currentPriceCatalog().data.list_usd[model];
    assert.equal(row.fresh_input_per_m, 3); assert.equal(row.output_per_m, 15);
    assert.equal(row.cache_read_per_m, before.cache_read_per_m);
    assert.equal(row.max_input_tokens, before.max_input_tokens);
    assert.deepEqual(row.above, before.above);
    const pinned = {example: {provider: 'openai', max_input_tokens: 1000, fresh_input_per_m: 1, output_per_m: 1,
      above: {threshold: 100}, priority: {cache_read_per_m: 5}}};
    const fetched = {example: {...pinned.example, above: {threshold: 100, cache_read_per_m: 2}}};
    assert.deepEqual(mergeListPrices(pinned, fetched), pinned, 'an above-tier rate must not lower a speed-tier fallback');
    const data = structuredClone(currentPriceCatalog().data);
    data.list_usd[model].fresh_input_per_m = 1;
    const revision = priceCatalogRevision(data);
    const {mkdir} = await import('node:fs/promises');
    await mkdir(join(directory, 'prices'));
    await writeFile(join(directory, 'prices', revision.replace(':', '-') + '.json'), JSON.stringify(data));
    assert.equal(readPriceSnapshot(directory, revision).revision, revision);
  } finally { setLiveListPrices({}); await rm(directory, {recursive: true, force: true}); }
});

test('M3 imports every threshold and prices strict boundaries and mixed calls', async () => {
  const {parseLiteLLM, contextPriceTiers, mergeListPrices} = await import('../lib/v1/litellm-prices.mjs');
  const {effectivePriceCatalog, withPriceCatalog, worstCallUsd} = await import('../lib/v1/lending-meter.mjs');
  const model = 'claude-sonnet-99';
  const rows = parseLiteLLM({[model]: {litellm_provider: 'anthropic',
    input_cost_per_token: 0.000001, output_cost_per_token: 0.000002,
    input_cost_per_token_above_100k_tokens: 0.000002,
    input_cost_per_token_above_200k_tokens: 0.000004,
    input_cost_per_token_above_272k_tokens: 0.000008}});
  const catalog = effectivePriceCatalog(rows);
  for (const [prompt, per_million_usd] of [[100000, 1], [150000, 2], [200000, 2], [250000, 4], [272000, 4], [300000, 8]]) {
    const tokens = {...emptyTokens(), fresh_input: prompt};
    assert.equal(priceListUsd(model, tokens, {catalog, calls: [{...tokens, prompt}]}).usd, prompt * per_million_usd / 1_000_000);
  }
  assert.deepEqual(contextPriceTiers(rows[model]).map(t => t.threshold), [100000, 200000, 272000]);
  const calls = [150000, 250000].map(prompt => ({...emptyTokens(), fresh_input: prompt, prompt}));
  assert.equal(priceListUsd(model, {...emptyTokens(), fresh_input: 400000}, {catalog, calls}).usd, 1.3);
  const merged = mergeListPrices({[model]: {...rows[model], above_tiers: undefined, above: {threshold: 200000, fresh_input_per_m: 5}}}, rows);
  assert.deepEqual(contextPriceTiers(merged[model]).map(t => t.threshold), [100000, 200000, 272000]);
  assert.equal(withPriceCatalog(catalog, () => worstCallUsd(model, {maxPromptTokens: 300000, maxOutputTokens: 0})), 2.4);
});

test('R3 intermediate context pricing is observable without new structural helpers', async () => {
  const {parseLiteLLM} = await import('../lib/v1/litellm-prices.mjs');
  const {effectivePriceCatalog} = await import('../lib/v1/lending-meter.mjs');
  const model = 'claude-sonnet-99';
  const catalog = effectivePriceCatalog(parseLiteLLM({[model]: {litellm_provider: 'anthropic',
    input_cost_per_token: 0.000001, output_cost_per_token: 0.000002,
    input_cost_per_token_above_100k_tokens: 0.000002,
    input_cost_per_token_above_200k_tokens: 0.000004}}));
  const tokens = {...emptyTokens(), fresh_input: 150000};
  assert.equal(priceListUsd(model, tokens, {catalog, calls: [{...tokens, prompt: 150000}]}).usd, 0.3);
});

test('M4 malformed JSON cache containers recover and retain restart throttling', async () => {
  for (const malformed of [null, false, 1, 'bad', []]) {
    const directory = await mkdtemp(join(tmpdir(), 'price-cache-shape-'));
    let calls = 0;
    const fetcher = async () => { calls++; return {ok: true, json: async () => document}; };
    try {
      await writeFile(join(directory, 'lending-prices-cache.json'), JSON.stringify(malformed));
      const refresh = startPriceRefresh({directory, fetcher, now: () => 100000000});
      try { await refresh.flight; } finally { refresh.close(); }
      assert.equal(calls, 1);
      const saved = JSON.parse(await readFile(join(directory, 'lending-prices-cache.json'), 'utf8'));
      assert.deepEqual(saved, {attempted_at: 100000000, document});
      const restart = startPriceRefresh({directory, fetcher, now: () => 100000001});
      try { await restart.flight; } finally { restart.close(); }
      assert.equal(calls, 1);
    } finally { setLiveListPrices({}); await rm(directory, {recursive: true, force: true}); }
  }
});
