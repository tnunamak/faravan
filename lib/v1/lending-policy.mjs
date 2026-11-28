// Saved lending settings and the pure allocation used by account decisions.
import {decideObjectiveLend, objectiveProjection, usdForPointsMicro, DEFAULT_PROTECTION, MICRO, PROTECTION_POSITIONS} from './lending-objective.mjs';

import {DIALS, STRATEGY_COPY, budgetLimitCopy} from './lending-status-copy.mjs';

const PERCENT = {type: 'number', minimum: 0, maximum: 100};

export const LENDING_PARAMETERS = Object.freeze({
  perJobPct: Object.freeze({...PERCENT, default: 10, description: 'Per-job cap: 10% of the weekly window by default. You can change it. Faravan stops a job when its measured use reaches the cap. A hold lasts until the meter shows its use or the weekly reset.'}),
  fixedSharePct: Object.freeze({...PERCENT, default: 20, description: 'Friends use at most this percentage of each week.'}),
  keepPct: Object.freeze({...PERCENT, default: 30, description: "Faravan doesn't lend the last part of each week's usage, set as a percentage."}),
  e0: Object.freeze({type: 'number', minimum: 0.2, maximum: 0.5, default: 0.5,
    description: 'Friends can start at this fraction of the week, from 0.2 to 0.5.'}),
});

export const LENDING_STRATEGIES = Object.freeze({
  automatic: Object.freeze({applies: Object.freeze(['perJobPct'])}),
  fixed_share: Object.freeze({applies: Object.freeze(['fixedSharePct', 'keepPct', 'perJobPct'])}),
  custom: Object.freeze({applies: Object.freeze(['e0', 'perJobPct'])}),
});

export const LENDING_STRATEGY_IDS = Object.freeze(Object.keys(LENDING_STRATEGIES));

export const LENDING_PRESETS = LENDING_STRATEGY_IDS;

export const ACCOUNT_PLANS = Object.freeze(['unknown', 'pro', 'max5', 'max20', 'plus', 'business', 'team']);

export const LEGACY_STRATEGY_PARAM_KEYS = Object.freeze(['e0', 'fixedSharePct', 'keepPct', 'perJobPct', 'hourlyRatePct', 'tailHours',
  'tailKeepPct', 'openKeepPct', 'activityThreshold', 'recentActivityMinutes', 'forecast', 'resetKeepPct', 'nearResetHours', 'allowOpenWindow']);

export const LENDING_POLICY_DEFAULTS = Object.freeze({
  strategy: 'automatic',
  strategyParams: Object.freeze({perJobPct:10}),
  protectionPosition: DEFAULT_PROTECTION,
  warningPct: 10,
  effortMax: 'high',
  allowFast: false,
  stopOnReturn: false,
  machineSlots: null,
  accountSlots: 1,
  watchOnlyUntil: null,
  providerConsent: {},
  accountPlans: {claude: 'unknown', codex: 'unknown'},
  probeMinutes: 30,
});

function lendingPolicyRefusal(field, reason) {
  return Object.assign(new Error('invalid_lending_policy'), {field, reason});
}

function normalizeStrategyParams(strategy, given = {}) {
  if (!given || typeof given !== 'object' || Array.isArray(given)) throw lendingPolicyRefusal('strategyParams', 'must be an object');
  for (const key of Object.keys(given))
    if (!LEGACY_STRATEGY_PARAM_KEYS.includes(key)) throw lendingPolicyRefusal('strategyParams.' + key, 'is not a known parameter');
  const params = {...given};
  for (const key of LENDING_STRATEGIES[strategy].applies) {
    const spec = LENDING_PARAMETERS[key];
    if (params[key] === undefined || params[key] === null) {
      delete params[key];
      if (spec.default !== undefined) params[key] = spec.default;
      continue;
    }
    if (typeof params[key] !== 'number' || !Number.isFinite(params[key])) throw lendingPolicyRefusal('strategyParams.' + key, 'must be number');
    if (params[key] < spec.minimum || params[key] > spec.maximum)
      throw lendingPolicyRefusal('strategyParams.' + key, 'must be from ' + spec.minimum + ' to ' + spec.maximum);
  }
  return Object.freeze(params);
}

export function normalizeLendingPolicy(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw lendingPolicyRefusal('lendingPolicy', 'must be an object');
  const unknown = Object.keys(input).find(k => !(k in LENDING_POLICY_DEFAULTS));
  if (unknown !== undefined) throw lendingPolicyRefusal(unknown, 'is not a known field');
  const p = {...LENDING_POLICY_DEFAULTS, ...input};
  if (!LENDING_STRATEGY_IDS.includes(p.strategy)) throw lendingPolicyRefusal('strategy', 'must be one of ' + LENDING_STRATEGY_IDS.join(', '));
  p.strategyParams = normalizeStrategyParams(p.strategy, p.strategyParams);
  if (!Object.hasOwn(PROTECTION_POSITIONS, p.protectionPosition))
    throw lendingPolicyRefusal('protectionPosition', 'must be one of ' + Object.keys(PROTECTION_POSITIONS).join(', '));
  if (!Number.isFinite(p.warningPct) || p.warningPct < 0 || p.warningPct > 100 ||
      !Number.isSafeInteger(p.probeMinutes) || p.probeMinutes < 15 || p.probeMinutes > 120) throw new Error('invalid_lending_policy');
  for (const key of ['allowFast', 'stopOnReturn']) if (typeof p[key] !== 'boolean') throw new Error('invalid_lending_policy');
  for (const key of ['machineSlots', 'accountSlots']) if (p[key] !== null &&
      (!Number.isSafeInteger(p[key]) || p[key] < 1 || p[key] > (key === 'accountSlots' ? 3 : 32))) throw new Error('invalid_lending_policy');
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(p.effortMax)) throw new Error('invalid_lending_policy');
  if (p.watchOnlyUntil !== null && !Number.isFinite(p.watchOnlyUntil)) throw new Error('invalid_lending_policy');
  if (!p.providerConsent || typeof p.providerConsent !== 'object' || Array.isArray(p.providerConsent) ||
      Object.entries(p.providerConsent).some(([k, v]) => !['claude', 'codex'].includes(k) || typeof v !== 'boolean'))
    throw new Error('invalid_lending_policy');
  if (!p.accountPlans || typeof p.accountPlans !== 'object' || Array.isArray(p.accountPlans) ||
      Object.entries(p.accountPlans).some(([k, v]) => !['claude', 'codex'].includes(k) ||
        !['unknown', 'pro', 'max5', 'max20', 'plus', 'business', 'team'].includes(v))) throw new Error('invalid_lending_policy');
  return p;
}

export function repairLendingPolicy(saved, defaults) {
  if (saved === undefined || saved === null) return null;
  try { normalizeLendingPolicy({...defaults, ...saved}); return null; } catch {}
  if (typeof saved !== 'object' || Array.isArray(saved))
    return {policy: {...defaults, providerConsent: {}}, reset: [{field: 'lendingPolicy', was: saved}]};
  let policy = {...defaults};
  const reset = [];
  const accept = (key, value) => {
    try { normalizeLendingPolicy({...policy, [key]: value}); policy = {...policy, [key]: value}; return true; } catch { return false; }
  };
  for (const key of ['strategy', ...Object.keys(saved).filter(k => k !== 'strategy' && k !== 'strategyParams')]) {
    if (!Object.hasOwn(saved, key)) continue;
    const value = saved[key];
    if (Object.hasOwn(defaults, key) && accept(key, value)) continue;
    if ((key === 'providerConsent' || key === 'accountPlans') && value && typeof value === 'object' && !Array.isArray(value)) {
      for (const [provider, setting] of Object.entries(value)) accept(key, {...policy[key], [provider]:setting});
    }
    reset.push({field:key, was:value});
  }
  if (Object.hasOwn(saved, 'strategyParams')) {
    const params = saved.strategyParams;
    if (!params || typeof params !== 'object' || Array.isArray(params)) reset.push({field: 'strategyParams', was: params});
    else for (const [key, value] of Object.entries(params))
      if (!accept('strategyParams', {...policy.strategyParams, [key]: value})) reset.push({field: 'strategyParams.' + key, was: value});
  }
  return {policy, reset};
}

export function evaluateLending({objectiveInput = null, policy = {}} = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) normalizeLendingPolicy(policy);
  const policyInput = {...policy};
  if (policyInput.strategy === undefined) policyInput.strategy = objectiveInput?.strategy ?? 'automatic';
  if (policyInput.strategyParams === undefined) policyInput.strategyParams = objectiveInput?.strategyParams ?? {};
  policy = normalizeLendingPolicy(policyInput);
  if (!objectiveInput) return {admitted: false, reason: 'objective_evidence_unknown', budget_units: 0, objective: null};
  const strategy=policy.strategy;
  const {strategyCeilingUsdMicro, policyCapBinds, strategyCeilingPointsMicro} = strategyCapsMicro(objectiveInput, policy);
  // Hand approval can replace an unknown automatic estimate with measured spare capacity. Explicit fixed-share or custom
  // limits still apply because they are deterministic owner controls, not estimates.
  const manualApproval = objectiveInput.automatic === false;
  const handApproved = manualApproval && strategy === 'automatic';
  const hasTypedCeiling = strategy === 'fixed_share' || strategy === 'custom';
  // Typed strategy ceilings remain an owner cap; automatic jobs still need the objective's predictive owner reserve.
  const decisionStrategy = manualApproval ? 'manual_approval' : 'automatic';
  const decision = decideObjectiveLend({...objectiveInput, strategy:decisionStrategy, strategyConfig:undefined,
    position: policy.protectionPosition ?? DEFAULT_PROTECTION, strategyCeilingUsdMicro, strategyCeilingPointsMicro});
  const strategyLimitHold = hasTypedCeiling && policyCapBinds && decision.reason === 'request_too_large';
  const reason = strategyLimitHold ? 'strategy_limit' : decision.reason;
  const reasonCode = strategyLimitHold ? 'objective_strategy_limit' : decision.reasonCode;
  // Explain a typed strategy ceiling through its own control.
  const strategyBudget = hasTypedCeiling && policyCapBinds && decision.reason === 'budget_too_small' &&
    decision.budgetLimit?.source === 'strategy' ? {...decision.budgetLimit, source:'strategy'} : null;
  const reasonText = strategyBudget ? budgetLimitCopy(strategyBudget).line : strategyLimitHold
    ? 'Holding this job: it exceeds the limit you set for this lending strategy. Review the Lend page to change it.'
    : hasTypedCeiling && decision.reason === 'lend' && decision.conversion !== 'native_window'
      ? `Lending within your ${STRATEGY_COPY[strategy].label.toLowerCase()} limits. ${STRATEGY_COPY[strategy].description}`
      : decision.reasonText;
  const explained={...decision,...(strategyBudget ? {budgetLimit:strategyBudget} : {}),reason,reasonCode,reasonText,strategyId:handApproved?'manual_approval':strategy,
    strategyExplanation:handApproved?decision.strategyExplanation:
      STRATEGY_COPY[strategy]?.description??STRATEGY_COPY.automatic.description};
  const objective=objectiveProjection(explained);
  return {...explained, reason, budget_units: decision.nativeBudgetUsdMicro / MICRO,
    objective, projection:objective};
}

const pointsMicro = points => Math.floor(points * MICRO);

const WEEK_MS = 7 * 24 * 3600 * 1000;

export function strategyCeilingMicro(policy, weekly, now) {
  const params = policy.strategyParams ?? {};
  const ceilings = [];
  // A present per-job cap that is not a number holds the job: it never silently means no cap.
  if (params.perJobPct !== undefined && params.perJobPct !== null)
    ceilings.push(Number.isFinite(params.perJobPct) ? Math.max(0, pointsMicro(params.perJobPct)) : 0);
  if (policy.strategy === 'fixed_share') {
    const numbers = Number.isFinite(params.fixedSharePct) && Number.isFinite(params.keepPct) &&
      Number.isSafeInteger(weekly.lentMicro) && weekly.lentMicro >= 0;
    ceilings.push(numbers ? Math.max(0, Math.min(pointsMicro(params.fixedSharePct) - weekly.lentMicro,
      pointsMicro(100 - params.keepPct) - weekly.usedMicro)) : 0);
  }
  if (policy.strategy === 'custom') {
    // The pace line from the start point e0: friends may use 100 * (elapsed - e0) / (1 - e0) of the week, less what is used.
    const e0 = params.e0, elapsed = Math.min(1, Math.max(0, 1 - (weekly.resetAtMs - now) / WEEK_MS));
    const pace = Number.isFinite(e0) && e0 < 1 ? 100 * Math.max(0, (elapsed - e0) / (1 - e0)) : 0;
    ceilings.push(Math.max(0, Math.max(0, pointsMicro(pace) - weekly.usedMicro) - weekly.committedMicro));
  }
  return ceilings.length ? Math.min(...ceilings) : null;
}

function strategyCapsMicro(objectiveInput, policy) {
  const weekly = objectiveInput.windows?.[objectiveInput.weeklyResource ?? 'seven_day'];
  const ceiling = weekly ? strategyCeilingMicro(policy, weekly, objectiveInput.now) : null;
  if (ceiling === null) return {strategyCeilingUsdMicro:null, policyCapBinds:false, strategyCeilingPointsMicro:null};
  // Native-window mode has no conversion to turn the point ceiling into dollars, so the ceiling applies in points directly.
  if (weekly.conversion === 'native_window')
    return {strategyCeilingUsdMicro:null, policyCapBinds:false, strategyCeilingPointsMicro:ceiling};
  // Let the objective report unusable conversion evidence before applying a converted cap.
  if (!Number.isSafeInteger(weekly.pointsPerUsdMicro) || weekly.pointsPerUsdMicro <= 0)
    return {strategyCeilingUsdMicro:null, policyCapBinds:false, strategyCeilingPointsMicro:null};
  const strategyUsd = usdForPointsMicro(ceiling, weekly.pointsPerUsdMicro);
  return {strategyCeilingUsdMicro:strategyUsd,
    policyCapBinds:true, strategyCeilingPointsMicro:null};
}

export function lendingStrategyCatalog() {
  return {
    strategies: LENDING_STRATEGY_IDS.map(id => ({id, label: STRATEGY_COPY[id].label, description: STRATEGY_COPY[id].description,
      parameters: LENDING_STRATEGIES[id].applies.map(key => ({key, type: LENDING_PARAMETERS[key].type,
        minimum: LENDING_PARAMETERS[key].minimum, maximum: LENDING_PARAMETERS[key].maximum,
        default: LENDING_PARAMETERS[key].default ?? null, description: LENDING_PARAMETERS[key].description}))})),
    dials: Object.entries(PROTECTION_POSITIONS).map(([position, dial]) => ({position, label: dial.label, epsilon: dial.epsilon,
      description: DIALS[position].description, detail: DIALS[position].detail})),
  };
}

export function machineCapacity({ramBytes, cpus, memoryMb = 2048, cpu = 2}) {
  if (![ramBytes, cpus, memoryMb, cpu].every(Number.isFinite) || memoryMb <= 0 || cpu <= 0) return 0;
  return Math.max(0, Math.min(Math.floor((ramBytes - 4 * 1024 ** 3) / (memoryMb * 1024 ** 2)), Math.floor(cpus / cpu)));
}

const safeNat=n=>Number.isSafeInteger(n)&&n>=0;

export function repricedCommitmentMicro(resource, kappaMicro) {
 const outstanding=BigInt(resource.held_micro)+BigInt(resource.unrepresented_micro);
 if(!safeNat(resource.kappa_micro)||resource.kappa_micro===0||!safeNat(kappaMicro))return Number(outstanding);
 const old=BigInt(resource.kappa_micro),rate=BigInt(Math.max(resource.kappa_micro,kappaMicro));
 return Number((outstanding*rate+old-1n)/old);
}
