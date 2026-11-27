// Allocation strategy seam for the durable lending engine.
// A strategy may only return per-resource lendable capacity. The caller still applies the
// shared request, conversion, worst-call, owner-cap, reset, stop, and held-exposure checks.

export const LENDING_STRATEGY_IDS = Object.freeze(['automatic', 'fixed_share', 'custom', 'manual_approval']);
export const DEFAULT_LENDING_STRATEGY = 'automatic';

export const DEFAULT_STRATEGY_CONFIG = Object.freeze({
  fixedShare: Object.freeze({maxWeeklySharePct:null, keepWeeklyPct:null}),
  custom: Object.freeze({
    weekly:Object.freeze({maxSharePct:null, keepPct:null}),
    short:Object.freeze({maxSharePct:null, keepPct:null}),
  }),
});

const WINDOW_CAP_MICRO = 100_000_000;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const onlyKeys = (value, keys) => record(value) && Object.keys(value).every(key => keys.includes(key));

function pctPoints(pct, round) {
  if (!Number.isFinite(pct) || pct < 0 || pct > 100) throw new RangeError('invalid strategy percentage');
  const millionthsOfPct = BigInt(round(pct * 1_000_000));
  return Number(BigInt(WINDOW_CAP_MICRO) * millionthsOfPct / 100_000_000n);
}

function validPercent(value) {
  return value === null || Number.isFinite(value) && value >= 0 && value <= 100;
}

function completeWindow(window) {
  return window && Number.isFinite(window.maxSharePct) && Number.isFinite(window.keepPct);
}

function normalizeWindow(value, fallback) {
  if (value !== undefined && !record(value)) throw new Error('invalid_lending_strategy');
  const out = {...fallback, ...(value ?? {})};
  if (!onlyKeys(out, ['maxSharePct', 'keepPct']) || !validPercent(out.maxSharePct) || !validPercent(out.keepPct))
    throw new Error('invalid_lending_strategy');
  return out;
}

/** Validate and fill bounded declarative strategy parameters. */
export function normalizeStrategyConfig(input = {}) {
  if (!onlyKeys(input, ['fixedShare', 'custom'])) throw new Error('invalid_lending_strategy');
  if (input.fixedShare !== undefined && !record(input.fixedShare)) throw new Error('invalid_lending_strategy');
  const fixedShare = {...DEFAULT_STRATEGY_CONFIG.fixedShare, ...(input.fixedShare ?? {})};
  if (!onlyKeys(fixedShare, ['maxWeeklySharePct', 'keepWeeklyPct']) ||
      !validPercent(fixedShare.maxWeeklySharePct) || !validPercent(fixedShare.keepWeeklyPct)) throw new Error('invalid_lending_strategy');
  const customInput = input.custom ?? {};
  if (input.custom !== undefined && !record(customInput)) throw new Error('invalid_lending_strategy');
  if (!onlyKeys(customInput, ['weekly', 'short'])) throw new Error('invalid_lending_strategy');
  return {
    fixedShare,
    custom: {
      weekly:normalizeWindow(customInput.weekly, DEFAULT_STRATEGY_CONFIG.custom.weekly),
      short:normalizeWindow(customInput.short, DEFAULT_STRATEGY_CONFIG.custom.short),
    },
  };
}

/** Stable copy for status, CLI, API, MCP, and the UI. */
export function strategyExplanation(id, config = DEFAULT_STRATEGY_CONFIG) {
  if (id === 'automatic') return 'Automatic uses a finite whole-week history band at week boundaries, or the configured demand model.';
  if (id === 'manual_approval') return 'Manual approval uses measured spare capacity and the request’s spend, reset, and stop limits.';
  if (id === 'fixed_share') return completeWindow({maxSharePct:config.fixedShare.maxWeeklySharePct,keepPct:config.fixedShare.keepWeeklyPct})
    ? `Fixed share lends up to ${config.fixedShare.maxWeeklySharePct}% of weekly capacity and keeps at least ${config.fixedShare.keepWeeklyPct}%.`
    : 'Fixed share needs a weekly share limit and keep-back before it can lend.';
  if (id === 'custom') return completeWindow(config.custom.weekly) && completeWindow(config.custom.short)
    ? `Custom applies your weekly (${config.custom.weekly.maxSharePct}% share, ${config.custom.weekly.keepPct}% kept) and five-hour (${config.custom.short.maxSharePct}% share, ${config.custom.short.keepPct}% kept) limits.`
    : 'Custom needs weekly and five-hour share limits and keep-backs before it can lend.';
  throw new TypeError('unknown lending strategy');
}

export function strategyConfigReady(id, config = DEFAULT_STRATEGY_CONFIG) {
  if (id === 'automatic') return true;
  if (id === 'manual_approval') return true;
  if (id === 'fixed_share') return completeWindow({
    maxSharePct:config.fixedShare.maxWeeklySharePct,
    keepPct:config.fixedShare.keepWeeklyPct,
  });
  if (id === 'custom') return completeWindow(config.custom.weekly) && completeWindow(config.custom.short);
  throw new TypeError('unknown lending strategy');
}

function fixedShareRoom({remainingMicro, lentMicro, maxSharePct, keepPct}) {
  if (!Number.isSafeInteger(remainingMicro) || remainingMicro < 0 || remainingMicro > MAX_SAFE ||
      !Number.isSafeInteger(lentMicro) || lentMicro < 0 || lentMicro > MAX_SAFE)
    throw new RangeError('unknown strategy exposure');
  const shareLeft = Math.max(0, pctPoints(maxSharePct, Math.floor) - lentMicro);
  const aboveKeep = Math.max(0, remainingMicro - pctPoints(keepPct, Math.ceil));
  return Math.min(remainingMicro, shareLeft, aboveKeep);
}

/**
 * The documented strategy interface: (inputs) -> exact per-resource lendable micro-points.
 * `automaticLendableMicro` is already derived from the selected pace/history source. Fixed
 * share counts durable borrower spend and held exposure against its cumulative weekly cap.
 */
export function lendableByStrategy({id = DEFAULT_LENDING_STRATEGY, resources, automaticLendableMicro,
  config = DEFAULT_STRATEGY_CONFIG} = {}) {
  if (!LENDING_STRATEGY_IDS.includes(id) || !Array.isArray(resources) || resources.length === 0 || resources.length > 8)
    throw new TypeError('invalid lending strategy input');
  const normalized = normalizeStrategyConfig(config);
  if (id === 'fixed_share' &&
      (!Number.isFinite(normalized.fixedShare.maxWeeklySharePct) || !Number.isFinite(normalized.fixedShare.keepWeeklyPct)))
    throw new Error('lending_strategy_config_unknown');
  if (id === 'custom' && (!completeWindow(normalized.custom.weekly) || !completeWindow(normalized.custom.short)))
    throw new Error('lending_strategy_config_unknown');
  const ids = resources.map(resource => resource?.id);
  if (ids.some(id => typeof id !== 'string' || !id || id === '__proto__') || new Set(ids).size !== ids.length)
    throw new TypeError('invalid strategy resources');
  if (!record(automaticLendableMicro) || Object.keys(automaticLendableMicro).length !== ids.length ||
      ids.some(resourceId => !Object.hasOwn(automaticLendableMicro, resourceId)))
    throw new TypeError('automatic capacity must bind every resource');

  const lendableMicro = Object.fromEntries(resources.map(resource => {
    const {id:resourceId, kind, remainingMicro} = resource;
    if (!Number.isSafeInteger(remainingMicro) || remainingMicro < 0 || remainingMicro > MAX_SAFE)
      throw new RangeError('invalid remaining strategy capacity');
    if (id === 'automatic') {
      const value = automaticLendableMicro[resourceId];
      if (!Number.isSafeInteger(value) || value < 0 || value > remainingMicro)
        throw new RangeError('invalid automatic capacity');
      return [resourceId, value];
    }
    const lentMicro = resource.lentMicro;
    if (id === 'fixed_share' && kind === 'weekly') {
      return [resourceId, fixedShareRoom({remainingMicro, lentMicro,
        maxSharePct:normalized.fixedShare.maxWeeklySharePct, keepPct:normalized.fixedShare.keepWeeklyPct})];
    }
    if (id === 'custom' && (kind === 'weekly' || kind === 'short')) {
      const window = normalized.custom[kind];
      return [resourceId, fixedShareRoom({remainingMicro, lentMicro,
        maxSharePct:window.maxSharePct, keepPct:window.keepPct})];
    }
    return [resourceId, remainingMicro];
  }));
  return {id, lendableMicro, explanation:strategyExplanation(id, normalized),
    protectionSource:id === 'automatic' ? null : 'strategy'};
}
