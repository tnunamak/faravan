#!/usr/bin/env node
// Refresh a staged release catalog; retain its bundled copy on any failure.
import {readFile, writeFile, rename, unlink} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import {parseLiteLLM, mergeListPrices} from '../lib/v1/litellm-prices.mjs';
import {LITELLM_URL} from '../lib/v1/lending-price-refresh.mjs';

const target = process.argv[2];
if (!target) throw new Error('missing staged catalog path');
let temporary;
try {
  const response = await fetch(LITELLM_URL, {headers: {'User-Agent': 'Faravan'}, signal: AbortSignal.timeout(5000)});
  if (!response.ok) throw new Error('fetch failed');
  const bytes = await response.text();
  const models = parseLiteLLM(JSON.parse(bytes));
  const catalog = JSON.parse(await readFile(target, 'utf8'));
  catalog.list_usd.models = mergeListPrices(catalog.list_usd.models, models);
  catalog.list_usd.source = {file: LITELLM_URL, fetched_at: new Date().toISOString(), sha256: createHash('sha256').update(bytes).digest('hex')};
  temporary = target + '.' + randomUUID() + '.tmp';
  await writeFile(temporary, JSON.stringify(catalog, null, 1) + '\n');
  await rename(temporary, target);
} catch {
  if (temporary) await unlink(temporary).catch(() => {});
  console.error('LiteLLM refresh unavailable; using bundled lending prices');
}
