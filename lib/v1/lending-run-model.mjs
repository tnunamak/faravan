export const SUPPORTED_RUN_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
import {DEFAULT_RUN_MODEL, claudeCallHeadroomUsd, currentPriceCatalog, pricedModelIds} from './lending-meter.mjs';

// Resolve the scalar run preference before pricing a job or describing lending status.
export function resolveLenderRunModel(adapter, job = null) {
  return adapter.run?.model ?? job?.requirements?.model?.any_of?.find(model =>
    (adapter.models ?? adapter.advertisement?.models ?? []).includes(model)) ??
    (adapter.spec.harness_id === 'codex' ? DEFAULT_RUN_MODEL.codex : DEFAULT_RUN_MODEL.claude);
}

// Detailed validation is available to owner-facing callers without changing the array API.
export function configuredModelEffortsResult(adapter) {
  const result = {pairs:[], invalidPairs:[], problems:[]};
  const reject = (code, details = {}) => {
    result.pairs = [];
    result.problems.push({code,...details});
    return result;
  };
  const id = adapter.spec.harness_id;
  const provider = id === 'codex' ? 'codex'
    : id === 'claude-code-subscription' || id === 'claude-code-api-key' ? 'claude' : null;
  if (!provider) return reject('unsupported_harness');
  const run = adapter.run ?? {};
  const explicit = run.model_efforts !== undefined;
  const pairs = explicit ? run.model_efforts
    : [{model:run.model ?? DEFAULT_RUN_MODEL[provider],effort:run.effort ?? 'medium'}];
  if (!Array.isArray(pairs)) return reject('model_efforts_not_array');
  if (!pairs.length) return reject('empty_model_efforts');
  if (pairs.length > 32) return reject('too_many_model_effort_pairs',{limit:32});
  const seen = new Set(), models = new Set();
  // Leave scalar acceptance unchanged; explicit pairs share the automatic vocabulary.
  const efforts = explicit ? SUPPORTED_RUN_EFFORTS
    : SUPPORTED_RUN_EFFORTS.slice(0,SUPPORTED_RUN_EFFORTS.indexOf('high')+1);
  for (const [index,pair] of pairs.entries()) {
    if (!pair || typeof pair !== 'object' || Array.isArray(pair))
      return reject('invalid_model_effort_pair',{index});
    if (Object.keys(pair).some(key => key !== 'model' && key !== 'effort'))
      return reject('unknown_model_effort_key',{index});
    if (!Object.hasOwn(pair,'model') || !Object.hasOwn(pair,'effort'))
      return reject('invalid_model_effort_pair',{index});
    if (typeof pair.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(pair.model))
      return reject('invalid_model_name',{index});
    if (!efforts.includes(pair.effort)) {
      result.invalidPairs.push({index,model:pair.model,effort:pair.effort});
      result.problems.push({code:'unsupported_effort',index});
      continue;
    }
    const key = JSON.stringify([pair.model,pair.effort]);
    if (seen.has(key)) return reject('duplicate_model_effort_pair',{index});
    seen.add(key);
    models.add(pair.model);
    result.pairs.push({model:pair.model,effort:pair.effort});
  }
  if (models.size > 16) return reject('too_many_models',{limit:16});
  return result;
}

// Existing execution/status callers still receive only the valid configured pairs.
export function configuredModelEfforts(adapter) {
  return configuredModelEffortsResult(adapter).pairs;
}
export function matchingRun(advertisement,job) {
  // An automatic job is run as the one pair its claim names. The lender chose that pair before it claimed; this never chooses.
  if(job?.auto_run_v1!==undefined) {
    const pairs=advertisement.model_efforts,pair=pairs?.length===1?pairs[0]:null;
    return pair&&(!job.requirements.harness||job.requirements.harness.includes(pair.harness))?{model:pair.model,effort:pair.effort}:null;
  }
  if(job?.budget_v1?.effort===undefined)return null;
  const pair=advertisement.model_efforts?.find(p=>p.effort===job.budget_v1.effort&&
    (!job.requirements.harness||job.requirements.harness.includes(p.harness))&&
    (!job.requirements.model||job.requirements.model.any_of.includes(p.model)));
  return pair?{model:pair.model,effort:pair.effort}:null;
}

// A claim can narrow the advertisement to any configured pair. Cover those and no-effort jobs.
export function resolveLenderStatusModel(adapter) {
  const fallback = resolveLenderRunModel(adapter);
  if (adapter.spec.harness_id !== 'claude-code-subscription') return fallback;
  const lendable = lendableModelsFor('claude');
  const pairs = configuredModelEfforts(adapter).filter(p => !lendable || lendable.includes(p.model));
  const models = [fallback, ...pairs.map(pair =>
    matchingRun({model_efforts:[pair]}, {budget_v1:{effort:pair.effort}, requirements:{}})?.model)].filter(Boolean);
  return models.reduce((best, model) => {
    const cost = claudeCallHeadroomUsd(model), bestCost = claudeCallHeadroomUsd(best);
    return !Number.isFinite(bestCost) || bestCost <= 0 ? best
      : !Number.isFinite(cost) || cost <= 0 || cost > bestCost ? model : best;
  });
}

const lendableCatalogs = new WeakMap();
export function lendableModelsFor(provider) {
  if (provider !== 'claude') return null;
  const catalog = currentPriceCatalog();
  let models = lendableCatalogs.get(catalog);
  if (!models) {
    models = pricedModelIds().filter(model => model.startsWith('claude-'))
      .map(model => [model, claudeCallHeadroomUsd(model)])
      .filter(([, headroom]) => Number.isFinite(headroom));
    lendableCatalogs.set(catalog, models);
  }
  return models.map(([model]) => model);
}

