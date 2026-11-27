#!/usr/bin/env node
// Regenerates lib/v1/lending-prices.json from two local, pinned catalogs (no network):
//   --credits  minnows data/model-catalog/pricing/codex-credits-*.json  (Codex credits, the official rate card)
//   --litellm  T3 Code's usage-model-rates.json (a LiteLLM model_prices_and_context_window.json copy)
//   --credits-commit  the minnows commit the credits file was read at
// Each source's sha256 is recorded, so a reviewer can check the vendored numbers against the source.
import { parseLiteLLM } from '../lib/v1/litellm-prices.mjs';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const arg = name => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : null; };
const creditsPath = arg('credits'), litellmPath = arg('litellm'), creditsCommit = arg('credits-commit');
if (!creditsPath || !litellmPath || !creditsCommit) {
  console.error('usage: gen-lending-prices.mjs --credits FILE --credits-commit SHA --litellm FILE');
  process.exit(2);
}
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const creditsBytes = readFileSync(creditsPath), litellmBytes = readFileSync(litellmPath);
const credits = JSON.parse(creditsBytes), litellm = JSON.parse(litellmBytes);
const list = parseLiteLLM(litellm);

const out = {
  schema_version: 1,
  generated_by: 'scripts/gen-lending-prices.mjs',
  codex_credits: {
    unit: 'codex_credits_per_1m_tokens',
    source: { file: 'minnows data/model-catalog/pricing/' + creditsPath.split('/').pop(), commit: creditsCommit,
      sha256: sha(creditsBytes), retrieved_at: credits.retrieved_at, source_urls: credits.source_urls },
    // The rate card's footnote (minnows notes, 2026-09-22): "Fast mode uses 2.5x the Standard credit rate for
    // GPT-6 Astra, Sol, and Luna where available." No other speed multiplier is on the card, so others are unpriced.
    speed_multipliers: { standard: 1, fast: 2.5 },
    match: credits.match,
    models: credits.models,
  },
  list_usd: {
    unit: 'usd_per_1m_tokens',
    source: { file: 'T3 Code usage-model-rates.json (LiteLLM model_prices_and_context_window.json)',
      fetched_at: new Date(litellm.fetchedAtMs).toISOString(), sha256: sha(litellmBytes) },
    models: list,
  },
};
const target = fileURLToPath(new URL('../lib/v1/lending-prices.json', import.meta.url));
writeFileSync(target, JSON.stringify(out, null, 1) + '\n');
console.log(target, Object.keys(credits.models).length, 'credit rows,', Object.keys(list).length, 'list rows');
