// Shared conversion of LiteLLM's public catalog to lending price rows.
const MAX_RATE = 1000, MAX_CONTEXT = 10_000_000;
const validRate = value => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= MAX_RATE;
const perM = value => typeof value === 'number' ? Math.round(value * 1e6 * 1e6) / 1e6 : undefined;
const rateKeys = ['fresh_input_per_m', 'cache_read_per_m', 'cache_write_5m_per_m', 'cache_write_1h_per_m', 'output_per_m'];
const contextValid = value => Number.isSafeInteger(value) && value > 0 && value <= MAX_CONTEXT;
const resolved = (tier, base, key) => {
  const fresh = tier.fresh_input_per_m ?? base.fresh_input_per_m;
  if (key === 'cache_read_per_m' || key === 'cache_write_5m_per_m') return tier[key] ?? base[key] ?? fresh;
  if (key === 'cache_write_1h_per_m') return tier[key] ?? base[key] ?? tier.cache_write_5m_per_m ?? base.cache_write_5m_per_m ?? fresh;
  return tier[key] ?? base[key];
};
function raiseTier(pinned, incoming, base) {
  const out = {...pinned};
  for (const key of rateKeys) {
    const value = incoming?.[key];
    if (validRate(value) && value > resolved(pinned, base, key)) out[key] = value;
  }
  return out;
}
// Context tiers are internal catalog metadata, not a change to provider wire formats.
// Old stored catalogs retain their single `above` tier unchanged.
export function contextPriceTiers(row) {
  return row.above_tiers ?? (row.above ? [row.above] : []);
}
export function priceTierFor(row, prompt, speed = 'standard') {
  let tier = speed !== 'standard' && row[speed] ? {...row, ...row[speed]} : row;
  for (const above of contextPriceTiers(row)) {
    if (prompt > above.threshold) tier = {...tier, ...above};
  }
  return tier;
}

/** Exact id, then the longest catalog key that prefixes the id (dated or suffixed ids), else null (unpriced). */
export function lookupPriceRow(models, model) {
  if (typeof model !== 'string') return null;
  const id = model.replace(/^(anthropic|openai)\//, '').replace(/\[1m\]$/, '');
  if (Object.hasOwn(models, id)) return [id, models[id]];
  const key = Object.keys(models).filter(k => id.startsWith(k + '-') || id.startsWith(k + '.')).sort((a, b) => b.length - a.length)[0];
  return key ? [key, models[key]] : null;
}
// Existing rows retain their context and tier boundaries. Missing rates inherit the pinned rate's fallback.
export function mergeListPrices(pinned, fetched) {
  const out = {...pinned};
  // Process family rows first so an alias inherits any raised family rates too.
  for (const [key, row] of Object.entries(fetched).sort(([a], [b]) => a.length - b.length || a.localeCompare(b))) {
    if (!validPriceRow(row)) continue;
    const prior = lookupPriceRow(out, key)?.[1];
    if (!prior) { out[key] = row; continue; }
    const merged = raiseTier(prior, row, prior);
    for (const tier of ['above', 'priority', 'ultrafast']) {
      if (prior[tier] && row[tier] && (tier !== 'above' || prior[tier].threshold === row[tier].threshold))
        merged[tier] = raiseTier(prior[tier], row[tier], prior);
    }
    const boundaries = [...new Set([...contextPriceTiers(prior), ...contextPriceTiers(row)].map(t => t.threshold))].sort((a, b) => a - b);
    const sameLegacyBoundary = !prior.above_tiers && !row.above_tiers &&
      (!row.above || prior.above?.threshold === row.above.threshold);
    if (!sameLegacyBoundary) {
      // Retain every breakpoint. Explicit overrides must cover every previously
      // reachable speed combination; otherwise a context tier can lower a speed fallback.
      const tiers = boundaries.map(threshold => {
        const above = {threshold};
        for (const rate of rateKeys) {
          above[rate] = Math.max(...['standard', 'priority', 'ultrafast'].flatMap(speed =>
            [prior, row].map(model => {
              const effective = priceTierFor(model, threshold + 1, speed);
              return resolved(effective, effective, rate);
            })));
        }
        return above;
      });
      delete merged.above;
      delete merged.above_tiers;
      if (tiers.length === 1) merged.above = tiers[0];
      else if (tiers.length > 1) merged.above_tiers = tiers;
    }
    // A tier can inherit a speed rate. Verify the actual combinations as well as each field.
    const effective = (model, speed, prompt) => {
      const tier = priceTierFor(model, prompt, speed);
      return rateKeys.map(rate => resolved(tier, tier, rate));
    };
    const prompts = [0, ...boundaries.flatMap(threshold => [threshold, threshold + 1])];
    const safe = ['standard', 'priority', 'ultrafast'].every(speed => prompts.every(prompt => {
      const oldRates = effective(prior, speed, prompt), newRates = effective(merged, speed, prompt);
      return oldRates.every((value, index) => newRates[index] >= value);
    }));
    out[key] = safe ? merged : prior;
  }
  return out;
}
export function validPriceRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) || !['openai', 'anthropic'].includes(row.provider) ||
      !(row.max_input_tokens == null || contextValid(row.max_input_tokens)) ||
      !validRate(row.fresh_input_per_m) || !validRate(row.output_per_m)) return false;
  const validTier = tier => tier && typeof tier === 'object' && !Array.isArray(tier) &&
    rateKeys.every(key => !Object.hasOwn(tier, key) || validRate(tier[key]));
  if (!validTier(row)) return false;
  for (const name of ['above', 'priority', 'ultrafast']) {
    if (row[name] !== undefined && (!validTier(row[name]) || (name === 'above' && !contextValid(row[name].threshold)))) return false;
  }
  if (row.above_tiers !== undefined) {
    if (row.above !== undefined || !Array.isArray(row.above_tiers) || row.above_tiers.length === 0 ||
        !row.above_tiers.every((tier, i, tiers) => validTier(tier) && contextValid(tier.threshold) &&
          (i === 0 || tier.threshold > tiers[i - 1].threshold))) return false;
  }
  return true;
}


// LiteLLM keys priced here: first-party Anthropic models and OpenAI models Codex serves.
const keep = key => /^claude-(opus|sonnet|haiku|fable|mythos)-[0-9]/.test(key) && !/[/:@]/.test(key) ||
  /^gpt-(6|5\.[3-6])/.test(key) && !/[/:@]/.test(key);
export function parseLiteLLM(input) {
const doc = input?.document ?? input;
if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("invalid LiteLLM catalog");
const list = {};
for (const [key, row] of Object.entries(doc).sort(([a], [b]) => a.localeCompare(b))) {
  if (!keep(key) || !row || typeof row !== 'object' || !['anthropic', 'openai'].includes(row.litellm_provider)) continue;
  if (![row.input_cost_per_token, row.output_cost_per_token].every(v => Number.isFinite(v) && v >= 0)) continue;
  if (Object.entries(row).some(([k,v]) => /(?:cost_per_token|token_cost)/.test(k) && !validRate(perM(v)))) continue;
  const tier = suffix => {
    const t = {
      fresh_input_per_m: perM(row['input_cost_per_token' + suffix]),
      cache_read_per_m: perM(row['cache_read_input_token_cost' + suffix]),
      cache_write_5m_per_m: perM(row['cache_creation_input_token_cost' + suffix]),
      cache_write_1h_per_m: perM(row['cache_creation_input_token_cost_above_1hr' + suffix]),
      output_per_m: perM(row['output_cost_per_token' + suffix]),
    };
    return Object.fromEntries(Object.entries(t).filter(([, v]) => v !== undefined));
  };
  const base = tier('');
  if (base.fresh_input_per_m === undefined || base.output_per_m === undefined) continue;
  const entry = { provider: row.litellm_provider, max_input_tokens: contextValid(row.max_input_tokens) ? row.max_input_tokens : null, ...base };
  const thresholds = [...new Set(Object.keys(row).map(key => key.match(/_above_(\d+(?:k|m)?)_tokens$/)?.[1]).filter(Boolean))];
  const contextTiers = [];
  for (const label of thresholds) {
    const threshold = Number(label.replace(/[km]$/, '')) * (label.endsWith('m') ? 1_000_000 : label.endsWith('k') ? 1000 : 1);
    if (!contextValid(threshold)) continue;
    const above = tier('_above_' + label + '_tokens');
    if (Object.keys(above).length) contextTiers.push({threshold, ...above});
  }
  contextTiers.sort((a, b) => a.threshold - b.threshold);
  // Equivalent spellings (100k and 100000) must not produce duplicate boundaries.
  const uniqueTiers = [];
  for (const above of contextTiers) {
    const previous = uniqueTiers.at(-1);
    if (previous?.threshold === above.threshold) {
      for (const rate of rateKeys) if (above[rate] !== undefined) previous[rate] = Math.max(previous[rate] ?? 0, above[rate]);
    } else uniqueTiers.push(above);
  }
  if (uniqueTiers.length === 1) entry.above = uniqueTiers[0];
  else if (uniqueTiers.length > 1) entry.above_tiers = uniqueTiers;
  for (const speed of ['priority', 'ultrafast']) {
    const t = tier('_' + speed);
    if (t.fresh_input_per_m !== undefined) entry[speed] = t;
  }
  list[key] = entry;
}

if (!Object.keys(list).length) throw new Error("empty LiteLLM catalog");
return list;
}
