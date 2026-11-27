/**
 * Automatic model and effort: one exact pair, chosen from the pairs a lender offers.
 *
 * The borrower sends only an intent ("cheapest" or "strongest"). The lender calls selectAutoRun once, before it prices the
 * job against its allowance, and keeps the answer with the claim. This module has no I/O, clock or model call: the same
 * intent, pairs, cap, rank table and price snapshot always give the same answer, in any order of the pairs.
 */
import {currentPriceCatalog, priceListUsd} from './lending-meter.mjs';
import {AUTO_RUN_INTENTS} from './versions.mjs';
export {AUTO_RUN_INTENTS};

export const AUTO_RUN_RULE_VERSION = 'auto-run-v1';
export const SUPPORTED_RUN_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
const EFFORT_ORDER = SUPPORTED_RUN_EFFORTS;
const effortRank = effort => EFFORT_ORDER.indexOf(effort);

// How strong a model is, higher is stronger. It is a judgment kept in this table, never read from a price or a name.
// A model that is not listed has no known rank, so it can never be called the strongest. Within one line the order is
// release order; a rank is only compared between models of one lender's agent.
export const CAPABILITY_RANK = Object.freeze({
  'claude-haiku-4-5': 10, 'claude-haiku-4-5-20251001': 10, 'claude-haiku-5-5': 15,
  'claude-sonnet-4-5': 20, 'claude-sonnet-4-5-20250929': 20, 'claude-sonnet-4-6': 22, 'claude-sonnet-5': 25, 'claude-sonnet-5-5': 28,
  'claude-opus-4-5': 30, 'claude-opus-4-5-20251101': 30, 'claude-opus-4-6': 32, 'claude-opus-4-6-20260205': 32,
  'claude-opus-4-7': 34, 'claude-opus-4-7-20260416': 34, 'claude-opus-4-8': 36, 'claude-opus-5': 38, 'claude-opus-5-5': 40,
  'gpt-6-luna': 10, 'gpt-6-sol': 20, 'gpt-6-astra': 30,
});

// One reference run prices every model the same way, so "cheapest" compares like with like.
const REFERENCE_RUN = Object.freeze({fresh_input: 1_000_000, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, output: 1_000_000, reasoning: 0});
export function listPriceSnapshot(catalog = currentPriceCatalog()) {
  return {revision: catalog.revision, usd: model => {
    const priced = priceListUsd(model, REFERENCE_RUN, {catalog});
    return priced.priced ? priced.usd : null;
  }};
}

const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const fail = reason => ({ok: false, reason, rule_version: AUTO_RUN_RULE_VERSION});

// The caller reads the price catalog once (listPriceSnapshot) and passes that snapshot in, so the answer depends on nothing but its inputs.
export function selectAutoRun({intent, pairs, cap, rank = CAPABILITY_RANK, prices} = {}) {
  if (!AUTO_RUN_INTENTS.includes(intent)) return fail('unknown_intent');
  if (typeof prices?.usd !== 'function') return fail('no_price_snapshot');
  const capRank = effortRank(cap);
  if (capRank < 0 || !Array.isArray(pairs)) return fail('no_eligible_pair');
  const offered = pairs.filter(p => p && typeof p.model === 'string' && effortRank(p.effort) >= 0);
  const usable = offered.filter(p => effortRank(p.effort) <= capRank);
  const known = intent === 'cheapest' ? p => Number.isFinite(prices.usd(p.model)) : p => Number.isFinite(rank[p.model]);
  const candidates = usable.filter(known);
  if (!candidates.length) return fail('no_eligible_pair');
  const done = (pair, reason, capped) => ({ok: true, pair: {model: pair.model, effort: pair.effort}, rule_version: AUTO_RUN_RULE_VERSION,
    reason, capped, pricing_revision: prices.revision});
  if (intent === 'cheapest') {
    const best = [...candidates].sort((a, b) => prices.usd(a.model) - prices.usd(b.model) || effortRank(a.effort) - effortRank(b.effort) || compareText(a.model, b.model))[0];
    return done(best, 'lowest_list_price', false);
  }
  const best = [...candidates].sort((a, b) => rank[b.model] - rank[a.model] || effortRank(b.effort) - effortRank(a.effort) || compareText(a.model, b.model))[0];
  // Capped: the cap kept this lender from a stronger or higher-effort pair it offers.
  const capped = offered.filter(known).some(p => rank[p.model] > rank[best.model] || (p.model === best.model && effortRank(p.effort) > effortRank(best.effort)));
  return done(best, 'highest_capability_rank', capped);
}

// Which choices these pairs can satisfy. A lender advertises this list so a borrower is only offered a choice the lender can
// make: "strongest" needs a ranked model and "cheapest" needs a priced one. It asks selectAutoRun itself, with the highest
// effort allowed, so the promise and the later choice follow one rule. The live effort cap can still remove a pair at claim
// time; the lender checks that, and a job it cannot serve stays queued.
export function supportedAutoIntents({pairs, rank = CAPABILITY_RANK, prices} = {}) {
  return AUTO_RUN_INTENTS.filter(intent => selectAutoRun({intent, pairs, cap: EFFORT_ORDER[EFFORT_ORDER.length - 1], rank, prices}).ok);
}
