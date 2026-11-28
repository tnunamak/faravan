import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {durableJsonAsync} from '../durable-write.mjs';
import {parseLiteLLM} from './litellm-prices.mjs';
import {setLiveListPrices, effectivePriceCatalog, currentPriceCatalog} from './lending-meter.mjs';
import {savePriceSnapshot} from './lending-price-store.mjs';

export const LITELLM_URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const DAY = 86400000;

// This runs in the background. A failed attempt is recorded too, to avoid retrying on every restart.
export function startPriceRefresh({directory, fetcher = fetch, now = Date.now} = {}) {
  let stopped = false, flight;
  const path = join(directory, 'lending-prices-cache.json');
  const controller = new AbortController();
  async function activate(rows) {
    const snapshot = effectivePriceCatalog(rows);
    savePriceSnapshot(directory, snapshot);
    if (!stopped) setLiveListPrices(rows);
  }
  async function run() {
    try { savePriceSnapshot(directory, currentPriceCatalog()); } catch {}
    let cache = {};
    try { cache = JSON.parse(await readFile(path, 'utf8')); } catch {}
    if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {};
    if (cache.document) {
      try { await activate(parseLiteLLM(cache.document)); } catch {}
    }
    if (stopped || (Number.isFinite(cache.attempted_at) && now() - cache.attempted_at < DAY && now() >= cache.attempted_at)) return;
    cache.attempted_at = now();
    try {
      // Persist the attempt before contacting the network, including on a timeout or crash.
      await durableJsonAsync(path, cache);
      const response = await fetcher(LITELLM_URL, {headers: {'User-Agent': 'Faravan'}, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)])});
      if (!response.ok) throw new Error('price fetch failed');
      const document = await response.json();
      const rows = parseLiteLLM(document);
      if (stopped) return;
      await durableJsonAsync(path, {attempted_at: cache.attempted_at, document});
      await activate(rows);
    } catch {}
  }
  const tick = () => { if (!flight && !stopped) flight = run().catch(() => {}).finally(() => { flight = null; }); };
  tick();
  const timer = setInterval(tick, DAY); timer.unref();
  return {close() { stopped = true; clearInterval(timer); controller.abort(); }, get flight() { return flight; }};
}
