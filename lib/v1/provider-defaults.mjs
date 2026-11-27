// What a newly signed-in account lends by default: each model family's current model, in this order.
// A model whose family is not listed here is shown on the account screen but starts off.
export const FAMILY_ORDER = Object.freeze({
  claude: ['sonnet', 'opus', 'haiku', 'fable'],
  codex: ['sol', 'terra', 'astra', 'luna'],
});

// Provider model ids: claude-<family>-<major>[-<minor>][-<yyyymmdd>] and gpt-<major>[.<minor>]-<family>.
// A dated id is an alias of the undated model, so it never counts as the current one.
const PARSERS = {
  claude: id => {
    const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(-\d{8})?$/.exec(id);
    return m && {family: m[1], version: [Number(m[2]), Number(m[3] ?? 0)], dated: Boolean(m[4])};
  },
  codex: id => {
    const m = /^gpt-(\d+)(?:\.(\d+))?-([a-z]+)$/.exec(id);
    return m && {family: m[3], version: [Number(m[1]), Number(m[2] ?? 0)], dated: false};
  },
};
const newer = (a, b) => a.version[0] - b.version[0] || a.version[1] - b.version[1] || Number(b.dated) - Number(a.dated);

/** The ids of each family's current model, in the table's family order. */
export function currentModelIds(providerId, models) {
  const parse = PARSERS[providerId], order = FAMILY_ORDER[providerId];
  if (!parse || !order) return [];
  const best = new Map();
  for (const model of models) {
    const parsed = parse(model.id);
    if (!parsed || !order.includes(parsed.family)) continue;
    const old = best.get(parsed.family);
    if (!old || newer(parsed, old.parsed) > 0) best.set(parsed.family, {id: model.id, parsed});
  }
  return order.filter(family => best.has(family)).map(family => best.get(family).id);
}

/** Saved settings for a new account: the current models on, every effort allowed. Empty for an unknown provider. */
export function newAccountModelSettings(providerId, models) {
  const ids = currentModelIds(providerId, models);
  return {modelOrder: ids, modelPreferences: Object.fromEntries(ids.map(id => [id, {enabled: true, effortIds: null}]))};
}
