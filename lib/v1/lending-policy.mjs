import {MEASURED_POSTING_LAG_MS} from './lending-rule-defaults.mjs';
import {readingAgeReserve} from './lending-reading-age.mjs';
import {decideObjectiveLend, objectiveProjection, usdForPointsMicro, DEFAULT_PROTECTION, MICRO, PROTECTION_POSITIONS} from './lending-objective.mjs';
import {DIALS, STRATEGY_COPY, budgetLimitCopy} from './lending-status-copy.mjs';
import {mergeServedModelEvidence, observeServedModel, servedModelEvidence} from './served-model-evidence.mjs';
import {meterProvider, PROVIDER_PERCENT_UNCERTAINTY_MICRO, RESET_JITTER_MS} from './quota-registry.mjs';

// Provider usage can lag execution; both the runner and durable reducer enforce this delay.
export const NATIVE_SETTLEMENT_DELAY_MS = 120_000;

// A synthetic reset cannot prove that the real window a cold reservation opened has ended.
function accountWeekReset(accountWeekId, accountId) {
 const prefix=`${accountId}:weekly:`;
 if(!nonempty(accountId)||typeof accountWeekId!=='string'||!accountWeekId.startsWith(prefix))return null;
 const reset=Number(accountWeekId.slice(prefix.length));
 return safeNat(reset)?reset:null;
}

// A weekly rollover changes the epoch, but the provider account stays the same. The week id embeds
// that stable account id and the reset time, which lets a later verified read prove a forward rollover.
export function coldWindowAccountWeekProven(attempt, reading) {
 if(reading?.identity?.verified!==true||!nonempty(reading.identity.account_id))return false;
 const previousReset=accountWeekReset(attempt.account_week_id,reading.identity.account_id);
 if(attempt.account_week_id.includes(':weekly:')&&previousReset===null)return false;
 if(reading.account_week_id===attempt.account_week_id)return reading.epoch===attempt.epoch;
 const nextReset=accountWeekReset(reading.account_week_id,reading.identity.account_id);
 const weekly=Array.isArray(reading.resources)?reading.resources.filter(r=>r?.kind==='weekly'):[];
 return previousReset!==null&&nextReset!==null&&nextReset>previousReset&&
   safeNat(reading.observed_at)&&reading.observed_at>=previousReset&&weekly.length===1&&
   weekly[0].resets_at===nextReset&&weekly[0].instance===reading.epoch;
}

export function coldWindowResetProven(attempt, ledger, reading, at) {
 if(ledger.cold_open!==true)return true;
 if(reading?.identity?.verified!==true||reading.complete!==true||reading.refresh_succeeded!==true||
   !coldWindowAccountWeekProven(attempt,reading)||attempt.cleanup_proven!==true||
   !safeNat(attempt.cleanup_proof_persisted_at)||
   !safeNat(reading.observed_at)||reading.observed_at<attempt.cleanup_proof_persisted_at+NATIVE_SETTLEMENT_DELAY_MS||
   reading.observed_at<ledger.resets_at||reading.observed_at>at||at-reading.observed_at>60000||
   !Array.isArray(reading.resources))return false;
 const matches=reading.resources.filter(r=>r?.id===ledger.id);
 if(matches.length!==1)return false;
 const resource=matches[0];
 if(resource.cold_open===true||resource.state==='not_open')return true;
 if(resource.state!=='open'||!safeNat(resource.anchor_at))return false;
 return resource.anchor_at<ledger.anchor_at-RESET_JITTER_MS||
   resource.anchor_at>attempt.cleanup_proof_persisted_at+RESET_JITTER_MS;
}

// A complete same-account read, including a proven forward week, can prove an ended row was pruned from the provider response.
export function coldWindowResetOmissionProven(attempt, ledger, reading, at) {
 if(ledger.cold_open!==true||reading?.identity?.verified!==true||
   accountWeekReset(attempt.account_week_id,reading.identity.account_id)===null||
   !coldWindowAccountWeekProven(attempt,reading)||reading.complete!==true||reading.refresh_succeeded!==true||
   attempt.cleanup_proven!==true||!safeNat(attempt.cleanup_proof_persisted_at)||
   !safeNat(reading.observed_at)||reading.observed_at<attempt.cleanup_proof_persisted_at+NATIVE_SETTLEMENT_DELAY_MS||
   reading.observed_at<ledger.resets_at||reading.observed_at>at||at-reading.observed_at>60000||
   !Array.isArray(reading.resources))return false;
 return !reading.resources.some(resource=>resource?.id===ledger.id);
}

// The strategies the engine reads, with the parameters each one reads and their typed range. `automatic` lends by the dial
// position alone. fixed_share caps the friends' share of the week and keeps its floor. custom starts the friends' share at its
// start point e0 and grows it along the week. perJobPct caps one job's reservation under every strategy. A parameter a strategy
// does not read is kept as data (a migrated legacy number) and never changes a decision.
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
// Telemetry vocabularies. scripts/gen-telemetry-catalog.mjs turns both into catalog enums.
export const LENDING_PRESETS = LENDING_STRATEGY_IDS;
export const ACCOUNT_PLANS = Object.freeze(['unknown', 'pro', 'max5', 'max20', 'plus', 'business', 'team']);
// Legacy numbers a migrated fixed_share or custom strategy keeps verbatim, and the owner's per-job cap for every strategy.
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

// A refusal names the field it is about (strategyParams.perJobPct, for example) and why. The message stays invalid_lending_policy;
// app.mjs keeps the field on the invalid_request it answers with.
function lendingPolicyRefusal(field, reason) {
  return Object.assign(new Error('invalid_lending_policy'), {field, reason});
}
// The chosen strategy's live numbers: type and range from the table, and the catalog default for one the owner left out.
// A number the strategy does not read stays as saved (a migrated legacy number), unchecked.
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

// A saved policy this build refuses is repaired one field at a time: each bad field returns to its default, every valid field
// (consent and account plans included) is kept, and each reset names the value it replaced. Returns null when the policy is valid.
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

// The only admission allocator. Callers supply trusted current evidence and a complete objective input; missing input holds.
export function evaluateLending({objectiveInput = null, policy = {}} = {}) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) normalizeLendingPolicy(policy);
  const policyInput = {...policy};
  if (policyInput.strategy === undefined) policyInput.strategy = objectiveInput?.strategy ?? 'automatic';
  if (policyInput.strategyParams === undefined) policyInput.strategyParams = objectiveInput?.strategyParams ?? {};
  policy = normalizeLendingPolicy(policyInput);
  if (!objectiveInput) return {admitted: false, reason: 'objective_evidence_unknown', budget_units: 0, objective: null};
  const strategy=policy.strategy;
  const {ownerMaxJobUsdMicro, policyCapBinds, strategyCeilingPointsMicro} = jobUsdCapsMicro(objectiveInput, policy);
  // Hand approval can replace an unknown automatic estimate with measured spare capacity. Explicit fixed-share or custom
  // limits still apply because they are deterministic owner controls, not estimates.
  const manualApproval = objectiveInput.automatic === false;
  const handApproved = manualApproval && strategy === 'automatic';
  const hasTypedCeiling = strategy === 'fixed_share' || strategy === 'custom';
  // Typed strategy ceilings remain an owner cap; automatic jobs still need the objective's predictive owner reserve.
  const decisionStrategy = manualApproval ? 'manual_approval' : 'automatic';
  const decision = decideObjectiveLend({...objectiveInput, strategy:decisionStrategy, strategyConfig:undefined,
    position: policy.protectionPosition ?? DEFAULT_PROTECTION, ownerMaxJobUsdMicro, strategyCeilingPointsMicro});
  const strategyLimitHold = hasTypedCeiling && policyCapBinds && decision.reason === 'request_too_large';
  const reason = strategyLimitHold ? 'strategy_limit' : decision.reason;
  const reasonCode = strategyLimitHold ? 'objective_strategy_limit' : decision.reasonCode;
  // When a typed strategy ceiling is the smaller dollar cap, the owner changes that strategy, not the per-job limit.
  const strategyBudget = hasTypedCeiling && policyCapBinds && decision.reason === 'budget_too_small' &&
    decision.budgetLimit?.source === 'owner' ? {...decision.budgetLimit, source:'strategy'} : null;
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

// Typed strategy parameters bound one job's weekly reservation, in percentage points of the weekly window (100 points is the window).
// fixed_share caps its total share and leaves its keepPct floor. custom starts at e0 and grows its share line to reset.
// The ceiling becomes a USD cap at the weekly conversion; the owner's dollar cap also applies, and the smaller cap wins.
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
function jobUsdCapsMicro(objectiveInput, policy) {
  const owner = objectiveInput.ownerMaxJobUsdMicro ?? null;
  const weekly = objectiveInput.windows?.[objectiveInput.weeklyResource ?? 'seven_day'];
  const ceiling = weekly ? strategyCeilingMicro(policy, weekly, objectiveInput.now) : null;
  if (ceiling === null) return {ownerMaxJobUsdMicro:owner, policyCapBinds:false, strategyCeilingPointsMicro:null};
  // Native-window mode has no conversion to turn the point ceiling into dollars, so the ceiling applies in points directly.
  if (weekly.conversion === 'native_window')
    return {ownerMaxJobUsdMicro:owner, policyCapBinds:false, strategyCeilingPointsMicro:ceiling};
  // Let the objective report unusable conversion evidence before applying a converted cap.
  if (!Number.isSafeInteger(weekly.pointsPerUsdMicro) || weekly.pointsPerUsdMicro <= 0)
    return {ownerMaxJobUsdMicro:owner, policyCapBinds:false, strategyCeilingPointsMicro:null};
  const strategyUsd = usdForPointsMicro(ceiling, weekly.pointsPerUsdMicro);
  return {ownerMaxJobUsdMicro:owner === null ? strategyUsd : Math.min(owner, strategyUsd),
    policyCapBinds:owner === null || strategyUsd <= owner, strategyCeilingPointsMicro:null};
}

// What the operation registry and the app read: each strategy's label and one-line description, the parameters it reads with
// their typed range and default, and each dial position with its epsilon. The values come from the engine modules above.
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

// This core is versioned and inactive. A successful quote returns proposed state
// plus ordered effects; only the adapter can persist, open a provider window, or
// start/stop a process.
const PACE50_VERSION='objective-lending/m1';
const PACE50_STATE_VERSION='objective-lending/state/4';
const PACE50_POINT=1000000n;
const PACE50_HUNDRED=100n*PACE50_POINT;
const PACE50_HOUR_MS=3600000;
const PACE50_FIVE_HOURS_MS=5*PACE50_HOUR_MS;

const safeNat=n=>Number.isSafeInteger(n)&&n>=0;
const nonempty=s=>typeof s==='string'&&s.trim().length>0;
const record=v=>v!==null&&typeof v==='object'&&!Array.isArray(v)&&
 (Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);
const onlyKeys=(v,keys)=>Object.keys(v).every(k=>keys.includes(k));
const asMicro=n=>BigInt(n);
// A native rounding bound can exceed its capped charge. Other burns use their charged amount.
const burnExposureMicro=burn=>burn.exposure_micro??burn.amount_micro;
const minBig=values=>values.reduce((a,b)=>a<b?a:b);

// injected_rule records only the provenance class in state/4, not executable code or
// a candidate identity/version. It uses the same reservation and transition
// accounting as other sources; restart does not need the callback to stop/settle it.
// Repriced debt may exceed quota capacity; keep it readable and block lending rather than clip the liability.
function validLedgerResource(r) {
 if(!record(r)||!nonempty(r.id)||!nonempty(r.instance)||!nonempty(r.epoch)||
   !['weekly','short','model'].includes(r.kind)||
   !onlyKeys(r,['id','instance','epoch','kind','anchor_at','resets_at','duration_ms',
    'baseline_used_micro','kappa_micro','aggregate_observed_at','aggregate_used_micro',
    'initial_micro','spent_micro','settled_micro','held_micro','released_micro',
    'unrepresented_micro','meter_step_micro','native_release_used_micro','burns','protection_source','demand_model','conversion','overshoot_micro','cold_open','skipped_periods','usage_covered_at','cold_provenance'])||
   !['anchor_at','resets_at','duration_ms','baseline_used_micro',
    'aggregate_observed_at','aggregate_used_micro','initial_micro','spent_micro',
    'settled_micro','held_micro','released_micro','unrepresented_micro']
     .every(k=>safeNat(r[k]))||r.duration_ms===0||
   BigInt(r.resets_at)-BigInt(r.anchor_at)!==BigInt(r.duration_ms)||
   // A native-window reservation has no conversion at all: it is held and settled in window points. Any other reservation
   // carries its positive conversion. A zero conversion is never a stand-in for a missing one.
   (r.conversion===undefined?!safeNat(r.kappa_micro)||r.kappa_micro===0
    :r.conversion!=='native_window'||r.kappa_micro!==null)||
   (r.cold_open!==undefined&&(r.cold_open!==true||r.conversion!=='native_window'||r.kind!=='short'||r.baseline_used_micro!==0&&r.skipped_periods===undefined))||
   (r.usage_covered_at!==undefined&&(!safeNat(r.usage_covered_at)||r.usage_covered_at<r.anchor_at||r.usage_covered_at>=r.resets_at||r.usage_covered_at>r.aggregate_observed_at))||
   (r.cold_provenance!==undefined&&(r.cold_provenance!==true||r.conversion!=='native_window'||r.kind!=='short'))||
   (r.overshoot_micro!==undefined&&(r.conversion!=='native_window'||!safeNat(r.overshoot_micro)))||
   r.baseline_used_micro>Number(PACE50_HUNDRED)||
   r.aggregate_used_micro>Number(PACE50_HUNDRED)||
   r.aggregate_observed_at<r.anchor_at||r.aggregate_observed_at>=r.resets_at||
   !Array.isArray(r.burns)||
   (r.protection_source!==undefined&&!['history','model','strategy','injected_rule'].includes(r.protection_source))||
   (r.protection_source==='model'&&!validDemandModelForecast(r.demand_model))||
   (r.demand_model!==undefined&&r.protection_source!=='model'))return false;
 if(r.native_release_used_micro!==undefined&&(r.conversion!=='native_window'||!safeNat(r.native_release_used_micro)))return false;
 if(r.meter_step_micro!==undefined&&(r.conversion!=='native_window'||!safeNat(r.meter_step_micro)||r.meter_step_micro===0))return false;
 let spent=0n,unrepresented=0n;
 const burnIds=new Set();
 for(const b of r.burns){
  if(!record(b)||!nonempty(b.id)||!safeNat(b.amount_micro)||!safeNat(b.at)||
    typeof b.represented!=='boolean'||!onlyKeys(b,['id','amount_micro','at','represented','exposure_micro'])||
    (b.exposure_micro!==undefined&&(r.conversion!=='native_window'||r.native_release_used_micro===undefined||
     !safeNat(b.exposure_micro)||b.exposure_micro<b.amount_micro))||
    b.at<r.anchor_at||b.at>=r.resets_at||burnIds.has(b.id))return false;
  burnIds.add(b.id);spent+=asMicro(b.amount_micro);
  if(!b.represented)unrepresented+=asMicro(burnExposureMicro(b));
 }
 return spent===asMicro(r.spent_micro)&&unrepresented===asMicro(r.unrepresented_micro)&&
  asMicro(r.initial_micro)===asMicro(r.spent_micro)+asMicro(r.settled_micro)+
   asMicro(r.held_micro)+asMicro(r.released_micro);
}

function validDemandModelForecast(model) {
 if(!record(model)||!onlyKeys(model,['model_id','provenance','prior_state','origin_at_ms',
   'initial_capacity_points','initial_owner_used_micro','owner_count','reserve_points',
   'update_index','mark_bound','risk_alpha'])||!nonempty(model.model_id)||!nonempty(model.provenance)||
   !record(model.prior_state)||!safeNat(model.origin_at_ms)||
   !safeNat(model.initial_capacity_points)||model.initial_capacity_points===0||
   !safeNat(model.initial_owner_used_micro)||model.initial_owner_used_micro>Number(PACE50_HUNDRED)||
   !Number.isFinite(model.owner_count)||model.owner_count<0||
   !Number.isFinite(model.reserve_points)||model.reserve_points<0||
   !safeNat(model.update_index)||model.update_index===0||
   !Number.isFinite(model.mark_bound)||model.mark_bound<=0||
   !Number.isFinite(model.risk_alpha)||model.risk_alpha<=0||model.risk_alpha>=1)return false;
 try {
  const encoded=JSON.stringify(model.prior_state);
  return typeof encoded==='string'&&encoded.length<=8192&&JSON.parse(encoded)!==null;
 }catch{return false;}
}

// All native exposure not yet covered by the meter: held spend plus pending debits.
// Represented burns are excluded. Rates may raise this liability, never lower it.
export function repricedCommitmentMicro(resource, kappaMicro) {
 const outstanding=BigInt(resource.held_micro)+BigInt(resource.unrepresented_micro);
 if(!safeNat(resource.kappa_micro)||resource.kappa_micro===0||!safeNat(kappaMicro))return Number(outstanding);
 const old=BigInt(resource.kappa_micro),rate=BigInt(Math.max(resource.kappa_micro,kappaMicro));
 return Number((outstanding*rate+old-1n)/old);
}

function sameResourceScope(a,b) {
 return a.id===b.id&&a.instance===b.instance&&a.epoch===b.epoch&&
  a.anchor_at===b.anchor_at&&a.resets_at===b.resets_at;
}

function validRecoveryRecord(recovery,attempt) {
 if(!record(recovery)||!nonempty(recovery.settlement_id)||!nonempty(recovery.event_id)||
   !safeNat(recovery.at)||!safeNat(recovery.observed_at)||recovery.observed_at>recovery.at||
   BigInt(recovery.at)-BigInt(recovery.observed_at)>60000n||
   !(recovery.previous_settlement_id===null||nonempty(recovery.previous_settlement_id))||
   !Array.isArray(recovery.old_charges)||recovery.old_charges.length!==attempt.resources.length||
   !Array.isArray(recovery.resources)||!Array.isArray(recovery.resource_ids)||
   recovery.resources.length!==recovery.resource_ids.length||
   !onlyKeys(recovery,['settlement_id','event_id','previous_settlement_id','at','observed_at',
    'old_charges','resource_ids','resources']))return false;
 const oldCharges=new Map();
 for(const old of recovery.old_charges){
  const source=attempt.resources.find(r=>sameResourceScope(r,old??{}));
  if(!source||!record(old)||!onlyKeys(old,['id','instance','epoch','kind','anchor_at','resets_at',
    'kappa_micro','charged_micro'])||old.kind!==source.kind||old.kappa_micro!==source.kappa_micro||
    !safeNat(old.charged_micro)||old.charged_micro>source.initial_micro||
    oldCharges.has(source.id+'\u0000'+source.instance+'\u0000'+source.epoch))
   return false;
  oldCharges.set(source.id+'\u0000'+source.instance+'\u0000'+source.epoch,old);
 }
 const ids=new Set();
 const scopes=new Set();
 for(let i=0;i<recovery.resources.length;i++){
  const resource=recovery.resources[i],key=resource?.id+'\u0000'+resource?.instance+'\u0000'+resource?.epoch;
  if(!record(resource)||!nonempty(resource.id)||!nonempty(resource.instance)||!nonempty(resource.epoch)||
    !['weekly','short','model'].includes(resource.kind)||
    !onlyKeys(resource,['id','instance','epoch','kind','anchor_at','resets_at','duration_ms',
     'baseline_used_micro','used_micro','kappa_micro','charged_micro','cumulative_charged_micro',
     'source_resource_ids'])||
    !['anchor_at','resets_at','duration_ms','baseline_used_micro','used_micro','kappa_micro',
     'charged_micro','cumulative_charged_micro'].every(k=>safeNat(resource[k]))||
    resource.duration_ms===0||resource.kappa_micro===0||
    BigInt(resource.resets_at)-BigInt(resource.anchor_at)!==BigInt(resource.duration_ms)||
    recovery.observed_at<resource.anchor_at||recovery.observed_at>=resource.resets_at||
    resource.baseline_used_micro>Number(PACE50_HUNDRED)||resource.used_micro>Number(PACE50_HUNDRED)||
    !Array.isArray(resource.source_resource_ids)||resource.source_resource_ids.length===0||
    !resource.source_resource_ids.every(source=>record(source)&&
     onlyKeys(source,['id','instance','epoch','anchor_at','resets_at'])&&
     attempt.resources.some(old=>sameResourceScope(old,source)&&old.kind===resource.kind))||
    new Set(resource.source_resource_ids.map(source=>source.id+'\u0000'+source.instance+'\u0000'+
     source.epoch+'\u0000'+source.anchor_at+'\u0000'+source.resets_at)).size!==resource.source_resource_ids.length||
    ids.has(recovery.resource_ids[i])||recovery.resource_ids[i]!==resource.id||scopes.has(key))return false;
  let exactOldCharge=0n;
  for(const old of recovery.old_charges)if(sameResourceScope(old,resource))
   exactOldCharge+=asMicro(old.charged_micro);
  const original=attempt.resources.find(old=>sameResourceScope(old,resource));
  if(original&&resource.baseline_used_micro!==original.baseline_used_micro||
    BigInt(resource.baseline_used_micro)+exactOldCharge+
     BigInt(resource.cumulative_charged_micro)>BigInt(resource.used_micro))return false;
  ids.add(resource.id);scopes.add(key);
 }
 const mappedSources=new Set(recovery.resources.flatMap(resource=>
  resource.source_resource_ids.map(resourceIdentityKey)));
 return recovery.resources.length>0&&ids.size===recovery.resources.length&&
  attempt.resources.every(resource=>mappedSources.has(resourceIdentityKey(resource)));
}

function validServedModel(value) {
 if(!record(value))return false;
 const normalized=servedModelEvidence(value);
 return onlyKeys(value,Object.keys(normalized))&&Object.entries(normalized).every(([key,expected])=>value[key]===expected);
}

function validFeedbackRate(r) {
 return record(r)&&onlyKeys(r,['id','instance','epoch','anchor_at','resets_at','kappa_micro','used_micro'])&&
  nonempty(r.id)&&nonempty(r.instance)&&nonempty(r.epoch)&&
  ['anchor_at','resets_at','kappa_micro','used_micro'].every(k=>safeNat(r[k]))&&
  r.resets_at>r.anchor_at&&r.kappa_micro>0&&r.used_micro<=Number(PACE50_HUNDRED);
}
// Legacy state/4 feedback had only rates. Treat a blocked legacy record as pending
// for each remembered resource; separate receipts can drain it without losing rate memory.
function pendingFeedback(f) {
 return f.pending??(f.blocked?f.rates.map(r=>({...r,required_at:f.required_at})):[]);
}
// Only a canonical request provider matching the weekly meter can scope the fence.
// Unknown or conflicting ownership keeps feedback closed on every provider.
export function rateFeedbackBlocksProvider(state,provider,weeklyResourceId) {
 const owner=meterProvider(weeklyResourceId);
 const known=['claude','codex'].includes(provider)&&provider===owner;
 return state.rate_feedback?.blocked===true&&pendingFeedback(state.rate_feedback).some(r=>
  !known||meterProvider(r.id)===null||meterProvider(r.id)===owner);
}
function validPendingFeedback(p) {
 if(!record(p))return false;
 const {required_at,...rate}=p;
 return safeNat(required_at)&&validFeedbackRate(rate);
}
function validRateFeedback(f) {
 return record(f)&&onlyKeys(f,['blocked','required_at','covered_at','rates','pending'])&&typeof f.blocked==='boolean'&&
  safeNat(f.required_at)&&(f.covered_at===null||safeNat(f.covered_at)&&f.covered_at>=f.required_at)&&
  (!f.blocked||f.covered_at===null)&&Array.isArray(f.rates)&&f.rates.length>0&&f.rates.every(validFeedbackRate)&&
  new Set(f.rates.map(resourceIdentityKey)).size===f.rates.length&&
  (f.pending===undefined||Array.isArray(f.pending)&&f.pending.every(p=>validPendingFeedback(p)&&p.required_at<=f.required_at&&
    f.rates.some(r=>sameResourceScope(r,p)&&r.kappa_micro>=p.kappa_micro&&r.used_micro>=p.used_micro))&&
   new Set(f.pending.map(resourceIdentityKey)).size===f.pending.length&&f.blocked===(f.pending.length>0));
}

function validPace50State(s) {
 if(!record(s)||s.version!==PACE50_STATE_VERSION||!nonempty(s.account)||
   !nonempty(s.account_week_id)||!safeNat(s.revision)||!['on','paused','off'].includes(s.mode)||
   typeof s.owner_present!=='boolean'||
   !(s.owner_absent_since===null||safeNat(s.owner_absent_since))||
   (s.updated_at!==null&&!safeNat(s.updated_at))||
   (s.revision===0)!==(s.updated_at===null)||!Array.isArray(s.event_ids)||
   // A carry also records the cleanup proof it inherits as a synthetic id, which is not an applied event and does not advance the revision.
   s.revision<s.event_ids.filter(id=>!id.includes(':cleanup-proven:inherited:')).length||
   (s.owner_present&&s.owner_absent_since!==null)||
   (s.owner_absent_since!==null&&s.updated_at!==null&&s.owner_absent_since>s.updated_at)||
   !onlyKeys(s,['version','account','account_week_id','revision','mode','owner_present',
    'owner_absent_since','updated_at','opening_tokens','opened_windows','attempts','event_ids','rate_feedback',
    'provider_weeks'])||
   !Array.isArray(s.opening_tokens)||!Array.isArray(s.opened_windows)||
   !Array.isArray(s.attempts))return false;
 if(s.rate_feedback!==undefined&&(!validRateFeedback(s.rate_feedback)||
   s.updated_at===null||s.rate_feedback.required_at>s.updated_at||
   s.rate_feedback.covered_at!==null&&s.rate_feedback.covered_at>s.updated_at))return false;
 const tokens=new Set(),attemptIds=new Set(),eventIds=new Set(),burnOwners=new Map(),settlementIds=new Set();
 for(const token of s.opening_tokens){
  if(!record(token)||!nonempty(token.account_week_id)||
    !['unused','consumed'].includes(token.status)||
    !onlyKeys(token,['account_week_id','status','attempt_id','last_proof_id'])||
    (token.attempt_id!==null&&!nonempty(token.attempt_id))||tokens.has(token.account_week_id)||
    (token.status==='unused'&&token.attempt_id!==null)||
    (token.status==='consumed'&&token.attempt_id===null))return false;
  if(token.last_proof_id!==undefined&&!nonempty(token.last_proof_id))return false;
  tokens.add(token.account_week_id);
 }
 if(!tokens.has(s.account_week_id))return false;
 if(s.provider_weeks!==undefined&&(!record(s.provider_weeks)||
   !Object.entries(s.provider_weeks).every(([id,row])=>nonempty(id)&&record(row)&&
    onlyKeys(row,['account_week_id','resets_at'])&&tokens.has(row.account_week_id)&&safeNat(row.resets_at))))return false;
 for(const attempt of s.attempts){
  if(!record(attempt)||!nonempty(attempt.id)||attemptIds.has(attempt.id)||
    attempt.account!==s.account||!nonempty(attempt.account_week_id)||!nonempty(attempt.epoch)||
    !nonempty(attempt.job_id)||!safeNat(attempt.created_at)||!Array.isArray(attempt.resources)||
    attempt.resources.length===0||
    !(attempt.usage_unknown===undefined||attempt.usage_unknown===null||nonempty(attempt.usage_unknown))||
    !(attempt.cleanup_proven===undefined||typeof attempt.cleanup_proven==='boolean')||
    !(attempt.hold_closed===undefined||typeof attempt.hold_closed==='boolean')||
    !(attempt.owner_presence_override===undefined||attempt.owner_presence_override===true)||
    (attempt.owner_stop!==undefined&&(!record(attempt.owner_stop)||
     !onlyKeys(attempt.owner_stop,['event_id','requested_at','durable_intent_recorded'])||
     !nonempty(attempt.owner_stop.event_id)||!safeNat(attempt.owner_stop.requested_at)||
     attempt.owner_stop.durable_intent_recorded!==true||attempt.owner_stop.requested_at<attempt.created_at||
     attempt.owner_stop.requested_at>s.updated_at))||
    (attempt.cleanup_proof_persisted_at!==undefined&&attempt.cleanup_proof_persisted_at!==null&&
     (!safeNat(attempt.cleanup_proof_persisted_at)||attempt.cleanup_proven!==true||
      attempt.cleanup_proof_persisted_at<attempt.created_at||attempt.cleanup_proof_persisted_at>s.updated_at))||
    !(attempt.served_model===undefined||validServedModel(attempt.served_model))||
    !(attempt.price_rev===undefined||nonempty(attempt.price_rev))||
    (attempt.lineage_parent_id!==undefined&&(!nonempty(attempt.lineage_parent_id)||attempt.lineage_parent_id===attempt.id||!s.attempts.some(a=>a.id===attempt.lineage_parent_id)))||
    (attempt.pending_late_exposure!==undefined&&(!record(attempt.pending_late_exposure)||!onlyKeys(attempt.pending_late_exposure,['event_id','at'])||
     !nonempty(attempt.pending_late_exposure.event_id)||!safeNat(attempt.pending_late_exposure.at)||attempt.pending_late_exposure.at>s.updated_at))||
    !onlyKeys(attempt,['id','account','account_week_id','epoch','job_id','created_at',
     'wall_ms','stop_ms','uncertainty_ms','launch_state','process_state','cessation_proven',
     'late_ack_unresolved','late_ack_events','opening','resources','recoveries','usage_unknown','cleanup_proven','hold_closed',
     'owner_presence_override','owner_stop','cleanup_proof_persisted_at','served_model','price_rev','lineage_parent_id','pending_late_exposure'])||
    !safeNat(attempt.wall_ms)||attempt.wall_ms===0||
    !safeNat(attempt.stop_ms)||!safeNat(attempt.uncertainty_ms)||
    !['reserved','started','ambiguous','failed'].includes(attempt.launch_state)||
    !['not_started','running','unknown','cancel_requested','cessation_requested','ceased'].includes(attempt.process_state)||
    typeof attempt.cessation_proven!=='boolean'||typeof attempt.late_ack_unresolved!=='boolean'||
    !Array.isArray(attempt.late_ack_events)||!Array.isArray(attempt.recoveries)||
    attempt.cessation_proven!==(attempt.process_state==='ceased')||
    (attempt.opening!==null&&(!record(attempt.opening)||!nonempty(attempt.opening.resource_id)||
      !nonempty(attempt.opening.instance)||!safeNat(attempt.opening.anchor_at)||
      !safeNat(attempt.opening.resets_at)||!nonempty(attempt.opening.account_week_id)||
      attempt.opening.account_week_id!==attempt.account_week_id||
      BigInt(attempt.opening.resets_at)-BigInt(attempt.opening.anchor_at)!==BigInt(PACE50_FIVE_HOURS_MS)||
      !onlyKeys(attempt.opening,['resource_id','instance','anchor_at','resets_at','account_week_id','confirmed'])||
      typeof attempt.opening.confirmed!=='boolean')))return false;
  attemptIds.add(attempt.id);
  const lateEventIds=new Set();
  for(const late of attempt.late_ack_events){
   if(!record(late)||!nonempty(late.event_id)||!safeNat(late.at)||late.at<attempt.created_at||
     !(late.resolved_by===null||nonempty(late.resolved_by))||
     (late.cessation_at!==undefined&&(!safeNat(late.cessation_at)||late.cessation_at<late.at||late.cessation_at>s.updated_at))||
     !onlyKeys(late,['event_id','at','resolved_by','cessation_at'])||lateEventIds.has(late.event_id))return false;
   lateEventIds.add(late.event_id);
  }
  if(attempt.late_ack_unresolved!==attempt.late_ack_events.some(late=>late.resolved_by===null))return false;
  if(s.updated_at!==null&&(attempt.created_at>s.updated_at||
    attempt.late_ack_events.some(late=>late.at>s.updated_at)))return false;
  const resources=new Set();
  for(const resource of attempt.resources){
   if(!validLedgerResource(resource)||resource.epoch!==attempt.epoch||
     attempt.created_at<resource.anchor_at||attempt.created_at>=resource.resets_at||
     resources.has(resource.id+'\u0000'+resource.instance+'\u0000'+resource.epoch))return false;
   if(resource.skipped_periods!==undefined){
    if(!safeNat(resource.skipped_periods))return false;
    const source=s.attempts.flatMap(a=>Array.isArray(a?.resources)?a.resources.filter(record).map(r=>({attempt:a,resource:r})):[])
     .find(({attempt:a,resource:r})=>attempt.id===`${a.id}:carry:${r.id}:${r.instance}`&&r.id===resource.id);
    if(!source||skippedPeriods(source.resource,resource)!==resource.skipped_periods)return false;
   }
   resources.add(resource.id+'\u0000'+resource.instance+'\u0000'+resource.epoch);
   for(const burn of resource.burns){
    const owner=burnOwners.get(burn.id);
    if((owner!==undefined&&owner!==attempt.id)||
      s.updated_at!==null&&burn.at>s.updated_at)return false;
    burnOwners.set(burn.id,attempt.id);
   }
  }
  // A native-window attempt is native on every resource. It never opens a window and never carries a converted recovery.
  const nativeCount=attempt.resources.filter(r=>r.conversion==='native_window').length;
  if(nativeCount&&(nativeCount!==attempt.resources.length||attempt.recoveries.length||attempt.opening))return false;
  let previousRecovery=null;
  for(const recovery of attempt.recoveries){
   if(!validRecoveryRecord(recovery,attempt)||settlementIds.has(recovery.settlement_id)||
     recovery.at<attempt.created_at||s.updated_at!==null&&recovery.at>s.updated_at||
     recovery.previous_settlement_id!==(previousRecovery?.settlement_id??null)||
     previousRecovery&&recovery.at<previousRecovery.at)return false;
   settlementIds.add(recovery.settlement_id);
   for(const resource of recovery.resources){
    let previousCharge=0n;
    let previousObservation=null;
    for(const prior of attempt.recoveries){
     if(prior===recovery)break;
     for(const row of prior.resources)if(sameResourceScope(row,resource)){
      previousCharge+=asMicro(row.charged_micro);
      previousObservation={at:prior.observed_at,used_micro:row.used_micro};
     }
    }
    if(BigInt(resource.cumulative_charged_micro)!==previousCharge+BigInt(resource.charged_micro)||
      previousObservation&&(recovery.observed_at<previousObservation.at||
       resource.used_micro<previousObservation.used_micro))
     return false;
   }
   if(previousRecovery)for(const old of recovery.old_charges){
    const previous=previousRecovery.old_charges.find(row=>sameResourceScope(row,old));
    if(!previous||old.charged_micro<previous.charged_micro)return false;
   }
   previousRecovery=recovery;
  }
  if(attempt.recoveries.length){
   const latest=attempt.recoveries.at(-1);
   if(!attempt.late_ack_unresolved&&attempt.resources.some(resource=>{
    const old=latest.old_charges.find(row=>sameResourceScope(row,resource));
    // A newer pending execution may add a deadline charge after this reconciliation's immutable floor.
    const recoveredAt=s.event_ids.indexOf(latest.event_id);
    const laterCharge=resource.burns.filter(burn=>s.event_ids.indexOf(burn.id)>recoveredAt)
     .reduce((sum,burn)=>sum+BigInt(burn.amount_micro),0n);
    return !old||resource.held_micro!==0||resource.unrepresented_micro!==0||
     BigInt(resource.settled_micro)!==BigInt(old.charged_micro)-BigInt(resource.spent_micro)+laterCharge||
     BigInt(resource.released_micro)!==BigInt(resource.initial_micro)-BigInt(old.charged_micro)-laterCharge||
     resource.burns.some(burn=>!burn.represented);
   }))return false;
  }else if(attempt.resources.some(resource=>resource.settled_micro!==0))return false;
  // Financial protection can outlive either durable whole-tree cessation proof.
  if(attempt.process_state==='ceased'&&attempt.cleanup_proven!==true&&attempt.resources.some(r=>r.held_micro!==0||r.unrepresented_micro!==0)&&
   durableCessationBound(attempt,{state:s})===null)return false;
  if(attempt.opening){
   const resource=attempt.resources.find(r=>r.id===attempt.opening.resource_id&&
    r.instance===attempt.opening.instance&&r.kind==='short'&&
    r.anchor_at===attempt.opening.anchor_at&&r.resets_at===attempt.opening.resets_at);
   if(!resource)return false;
  }
 }
 const openedWeeks=new Set();
 for(const opened of s.opened_windows){
  if(!record(opened)||!nonempty(opened.account_week_id)||!nonempty(opened.resource_id)||
    !nonempty(opened.instance)||!nonempty(opened.epoch)||!nonempty(opened.attempt_id)||
    !safeNat(opened.anchor_at)||!safeNat(opened.resets_at)||
    BigInt(opened.resets_at)-BigInt(opened.anchor_at)!==BigInt(PACE50_FIVE_HOURS_MS)||
    !onlyKeys(opened,['account_week_id','resource_id','instance','epoch','anchor_at','resets_at','attempt_id'])||
    !attemptIds.has(opened.attempt_id)||openedWeeks.has(opened.account_week_id))return false;
  const owner=s.attempts.find(a=>a.id===opened.attempt_id);
  if(!owner||owner.account_week_id!==opened.account_week_id||owner.epoch!==opened.epoch||
    !owner.opening?.confirmed||owner.opening.resource_id!==opened.resource_id||
    owner.opening.instance!==opened.instance||owner.opening.anchor_at!==opened.anchor_at||
    owner.opening.resets_at!==opened.resets_at)return false;
  const token=s.opening_tokens.find(t=>t.account_week_id===opened.account_week_id);
  if(!token||token.status!=='consumed'||token.attempt_id!==opened.attempt_id)return false;
  openedWeeks.add(opened.account_week_id);
 }
 for(const token of s.opening_tokens)if(token.status==='consumed'){
  const owner=s.attempts.find(a=>a.id===token.attempt_id);
  if(!owner||owner.account_week_id!==token.account_week_id||!owner.opening)return false;
 }
 for(const id of s.event_ids){
  if(!nonempty(id)||eventIds.has(id))return false;
  eventIds.add(id);
 }
 for(const attempt of s.attempts)if(attempt.cleanup_proven===true&&
  !s.event_ids.some(id=>id.startsWith(`${attempt.id}:cleanup-proven:`)))return false;
 for(const attempt of s.attempts)if(attempt.owner_stop!==undefined&&
  !eventIds.has(attempt.owner_stop.event_id))return false;
 for(const attempt of s.attempts)for(const late of attempt.late_ack_events){
  if(!eventIds.has(late.event_id)||(late.resolved_by!==null&&!eventIds.has(late.resolved_by)))return false;
 }
 for(const attempt of s.attempts)for(const recovery of attempt.recoveries)
  if(!eventIds.has(recovery.event_id))return false;
 for(const token of s.opening_tokens)if(token.last_proof_id!==undefined&&!eventIds.has(token.last_proof_id))return false;
 for(const attempt of s.attempts)if(attempt.opening?.confirmed&&
   !s.opened_windows.some(opened=>opened.attempt_id===attempt.id))return false;
 return true;
}

// The latest verified week of each provider's weekly meter, with that week's reset time. A state written before
// provider_weeks existed derives it from its attempts: on each weekly meter, the attempt with the latest reset names the week.
function providerWeeks(state) {
 if(state.provider_weeks!==undefined)return state.provider_weeks;
 const weeks={};
 for(const attempt of state.attempts){
  const weekly=attempt.resources.find(r=>r.kind==='weekly');
  if(!nonempty(weekly?.id)||!safeNat(weekly.resets_at)||weeks[weekly.id]?.resets_at>=weekly.resets_at)continue;
  weeks[weekly.id]={account_week_id:attempt.account_week_id,resets_at:weekly.resets_at};
 }
 return weeks;
}

export function createEstimatedPace50State({account,account_week_id}={}) {
 if(!nonempty(account)||!nonempty(account_week_id))throw new Error('invalid_pace50_state_identity');
 return {version:PACE50_STATE_VERSION,account,account_week_id,revision:0,mode:'on',owner_present:false,
  owner_absent_since:null,updated_at:null,
  opening_tokens:[{account_week_id,status:'unused',attempt_id:null}],
  opened_windows:[],attempts:[],event_ids:[]};
}

// overshoot is the observed native use above each hold. It is lending consumption for strategy accounting, but it is not
// charged to the meter-side totals: the meter reading already holds it.
function attemptResourceTotals(state,id,instance,epoch,anchor,reset) {
 let spent=0n,held=0n,unrepresented=0n,overshoot=0n;
 for(const attempt of state.attempts){
  for(const r of attempt.resources)if(r.id===id&&r.instance===instance&&r.epoch===epoch&&
    r.anchor_at===anchor&&r.resets_at===reset){
   spent+=asMicro(r.spent_micro)+asMicro(r.settled_micro);
   held+=asMicro(r.held_micro);unrepresented+=asMicro(r.unrepresented_micro);
   overshoot+=asMicro(r.overshoot_micro??0);
  }
  for(const recovery of attempt.recoveries)for(const recovered of recovery.resources)
   if(recovered.id===id&&recovered.instance===instance&&recovered.epoch===epoch&&
     recovered.anchor_at===anchor&&recovered.resets_at===reset)
    spent+=asMicro(recovered.charged_micro);
 }
 return {spent,held,unrepresented,overshoot};
}

function aggregateWatermark(state,window) {
 let observedAt=null,used=0;
 const include=(at,amount)=>{
  if(observedAt===null||at>observedAt){observedAt=at;used=amount;}
  else if(at===observedAt&&amount>used)used=amount;
 };
 for(const attempt of state.attempts){
  for(const resource of attempt.resources)if(sameResourceScope(resource,window))
   include(resource.aggregate_observed_at,resource.aggregate_used_micro);
  for(const recovery of attempt.recoveries)for(const resource of recovery.resources)
   if(sameResourceScope(resource,window))include(recovery.observed_at,resource.used_micro);
 }
 return observedAt===null?null:{observed_at:observedAt,used_micro:used};
}

// What a reading of one window must show. The provider meter is one aggregate per window instance, so the reading covers the usage
// of every attempt on that scope. It must show the last accepted aggregate (or, before any, the earliest baseline on the scope) plus
// each unrepresented burn on the scope, from any attempt, that had happened by the reading. Null when the scope is not in the state.
function aggregateRequired(state,window,observedAt) {
 const watermark=aggregateWatermark(state,window);
 let base=watermark?asMicro(watermark.used_micro):null,burns=0n,found=false;
 for(const attempt of state.attempts)for(const resource of attempt.resources)if(sameResourceScope(resource,window)){
  found=true;
  if(!watermark){const baseline=asMicro(resource.baseline_used_micro);if(base===null||baseline<base)base=baseline;}
  for(const burn of resource.burns)if(!burn.represented&&burn.at<=observedAt)burns+=asMicro(burnExposureMicro(burn));
 }
 return found&&base!==null?base+burns:null;
}

// A ceased process whose hold is still open. A proven sandbox removal opens the hold (hold_closed false), and the final
// settlement closes it (true). Records written before the flag existed have none, and their ceased state already settled.
function settling(attempt) {
 return attempt.process_state==='ceased'&&attempt.hold_closed===false;
}

// Provider windows begin at first use; no readings exist for skipped periods.
// Codex ids encode minutes; Claude five_hour is 300 and seven_day meters are 10080.
export function skippedPeriods(source,successor) {
 if(!record(source)||!record(successor)||source.id!==successor.id||
   !safeNat(source.resets_at)||!safeNat(successor.anchor_at))return null;
 const provider=meterProvider(source.id);
 const minutes=provider==='codex'?Number(source.id.slice(6)):
  provider==='claude'?(source.id==='five_hour'?300:10080):null;
 // A meter outside the known vocabulary has no declared period; its own window length stands in.
 const period=minutes===null?(safeNat(source.duration_ms)?source.duration_ms:null):minutes*60000;
 if(!safeNat(period)||period===0)return null;
 const gap=BigInt(successor.anchor_at)-BigInt(source.resets_at);
 if(gap < -BigInt(RESET_JITTER_MS))return null;
 return gap<=0n?0:Number(gap/BigInt(period));
}

function originalAttempt(attempt,state) {
 const seen=new Set();
 while(attempt&&(attempt.lineage_parent_id||attempt.id?.includes(':carry:'))){
  if(!state||seen.has(attempt.id))return null;
  seen.add(attempt.id);
  const parents=state.attempts.filter(parent=>attempt.lineage_parent_id?parent.id===attempt.lineage_parent_id:parent.resources.some(resource=>
   attempt.id===`${parent.id}:carry:${resource.id}:${resource.instance}`&&
   attempt.account===parent.account&&attempt.resources.every(child=>child.id===resource.id&&child.kind===resource.kind)));
  if(parents.length!==1)return null;
  attempt=parents[0];
 }
 return attempt??null;
}

export function durableCessationBound(attempt,{state}={}) {
 const original=originalAttempt(attempt,state);
 if(!original)return null;
 const events=original.late_ack_events;
 if(original.cleanup_proven!==true&&events.length&&events.at(-1).cessation_at===undefined)return null;
 const candidates=events.filter(late=>safeNat(late.cessation_at)).map(late=>late.cessation_at);
 if(original.cleanup_proven===true&&safeNat(original.cleanup_proof_persisted_at))candidates.push(original.cleanup_proof_persisted_at);
 if(!candidates.length)return null;
 const ceased=Math.max(...candidates);
 const lineage=state?state.attempts.filter(row=>originalAttempt(row,state)?.id===original.id):[original];
 return lineage.every(row=>row.late_ack_events.every(late=>late.at<=ceased))?ceased:null;
}

export function executionProvenAbsent(attempt) {
 // Only a durable no-dispatch stamp can establish this; reserved state and reported zero use cannot.
 return false;
}

export function mayHaveSpentPast(attempt,resource,options={}) {
 const ceased=durableCessationBound(attempt,options);
 return ceased!==null&&BigInt(ceased)>=BigInt(resource.resets_at)-BigInt(RESET_JITTER_MS)&&
  !executionProvenAbsent(originalAttempt(attempt,options.state));
}

export function lateCarryBound(attempt,resource,options={}) {
 const ceased=durableCessationBound(attempt,options);
 if(ceased===null)return null;
 const reset=BigInt(resource.resets_at),end=BigInt(ceased)+BigInt(resource.duration_ms);
 const lateHistory=originalAttempt(attempt,options.state)?.late_ack_events.length>0;
 return (lateHistory||resource.cold_open===true||resource.cold_provenance===true||mayHaveSpentPast(attempt,resource,options))&&end>reset?end:reset;
}

export function resourceResetProven(attempt,resource,{state,evidence,at}={}) {
 // No trusted resource-reset evidence producer is installed on this branch yet.
 // Neither aggregate usage nor a sandbox-removal assertion proves the final covering window ended.
 return false;
}

function usageCovered(attempt,resource,{state,evidence,at,postingLagBoundMs}) {
 if(!safeNat(postingLagBoundMs)||!record(evidence)||!['usage_covered','usage_represented','native_meter_settled'].includes(evidence.type)||
   evidence.account!==attempt.account||evidence.account_week_id!==undefined&&evidence.account_week_id!==attempt.account_week_id||evidence.epoch!==attempt.epoch||evidence.complete!==true||evidence.compatible!==true||
   evidence.refresh_succeeded!==true||evidence.scope_rewritten===true||!safeNat(evidence.observed_at)||
   evidence.observed_at>at||at-evidence.observed_at>60000||!Array.isArray(evidence.resources))return false;
 const original=originalAttempt(attempt,state),ceased=durableCessationBound(attempt,{state});
 // Backend cleanup destroys the VM and verifies its absence (docker-backend.destroy -> _removeAndVerify).
 // Process exit and a borrower result do not supply this whole-spending-tree proof.
 if(!original||original.cleanup_proven!==true||ceased===null||(resource.cold_open===true||resource.cold_provenance===true)||
   mayHaveSpentPast(attempt,resource,{state})||evidence.observed_at<ceased+postingLagBoundMs||evidence.observed_at>=resource.resets_at)return false;
 const readings=evidence.resources.filter(r=>r?.id===resource.id);
 if(readings.length!==1)return false;
 const reading=readings[0],watermark=aggregateWatermark(state,resource);
 return reading.cold_open!==true&&!['inferred','bound','cold','lending'].includes(reading.origin)&&reading.scope_rewritten!==true&&reading.state!=='not_open'&&
  (reading.uncertainty_micro===undefined||safeNat(reading.uncertainty_micro)&&reading.uncertainty_micro>=(resource.meter_step_micro??PROVIDER_PERCENT_UNCERTAINTY_MICRO))&&
  sameResourceScope({...reading,epoch:evidence.epoch},resource)&&safeNat(reading.used_micro)&&
  reading.used_micro<=Number(PACE50_HUNDRED)&&reading.used_micro>=resource.baseline_used_micro&&
  (!watermark||reading.used_micro>=watermark.used_micro&&evidence.observed_at>=watermark.observed_at);
}

export function settlementEligibility(attempt,resource,{state,evidence,at,postingLagBoundMs=MEASURED_POSTING_LAG_MS}={}) {
 const original=originalAttempt(attempt,state);
 if(original&&executionProvenAbsent(original))return {reason:'no_use',nextEligibleAt:null};
 if(usageCovered(attempt,resource,{state,evidence,at,postingLagBoundMs}))return {reason:'usage_covered',nextEligibleAt:null};
 if(resourceResetProven(attempt,resource,{state,evidence,at}))return {reason:'reset_proven',nextEligibleAt:null};
 const bound=lateCarryBound(attempt,resource,{state});
 return {reason:bound!==null&&safeNat(at)&&BigInt(at)>=bound?'deadline_reached':'retain',nextEligibleAt:bound};
}

// A native reading closes a hold only when a measured posting bound makes every reserved scope usage-covered.
// Otherwise it can book a visible rise as spend, but the hold stays.
function nativeCoverageMeasured(attempt,state,event,postingLagBoundMs) {
 return !!attempt&&attempt.resources.length>0&&attempt.resources.every(ledger=>
  settlementEligibility(attempt,ledger,{state,evidence:event,at:event.at,postingLagBoundMs}).reason==='usage_covered');
}

function protectionRemovable(state,attempt,resource,event) {
 return settlementEligibility(attempt,resource,{state,evidence:event,at:event.at}).reason!=='retain';
}

function resolveLateExposure(attempt,event) {
 if(attempt.pending_late_exposure||!attempt.resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0))return;
 for(const late of attempt.late_ack_events)if(late.resolved_by===null)late.resolved_by=event.event_id;
 attempt.late_ack_unresolved=false;
 if(attempt.cleanup_proven===true){attempt.process_state='ceased';attempt.cessation_proven=true;attempt.hold_closed=true;}
}

// One state serves every provider on this device. Exposure on another provider's meter is not a stale instance of these
// windows, so it does not refuse; exposure on a meter outside the known vocabulary still does.
function stateHasCrossWindowExposure(state,windows) {
 const providers=new Set(windows.map(w=>meterProvider(w?.id)));
 return state.attempts.some(a=>a.pending_late_exposure&&a.resources.some(r=>meterProvider(r.id)===null||providers.has(meterProvider(r.id)))||a.resources.some(r=>
  (r.held_micro>0||r.unrepresented_micro>0)&&
  (meterProvider(r.id)===null||providers.has(meterProvider(r.id)))&&
  !windows.some(w=>w.id===r.id&&w.instance===r.instance&&w.epoch===r.epoch&&
   w.anchor_at===r.anchor_at&&w.resets_at===r.resets_at)));
}

function transitionResult(state,event,reason,effects=[]) {
 return {applied:false,reason,state,effects};
}

function markLateAcknowledgement(state,attempt,event) {
 const original=originalAttempt(attempt,state);
 if(original&&original.id!==attempt.id){
  original.late_ack_events.push({event_id:event.event_id,at:event.at,resolved_by:null,...(event.authoritative_cessation===true?{cessation_at:event.at}:{})});
  original.late_ack_unresolved=true;original.cleanup_proven=false;original.cleanup_proof_persisted_at=null;
  original.process_state='unknown';original.cessation_proven=false;original.hold_closed=false;
 }
 const live=state.attempts.some(row=>originalAttempt(row,state)?.id===original?.id&&
  (row.pending_late_exposure||row.resources.some(r=>r.held_micro>0||r.unrepresented_micro>0)));
 if(!live&&event.authoritative_cessation!==true&&original){
  original.pending_late_exposure={event_id:event.event_id,at:event.at};
  original.process_state='unknown';original.cessation_proven=false;original.hold_closed=false;
 }
 attempt.late_ack_events.push({event_id:event.event_id,at:event.at,resolved_by:null,...(event.authoritative_cessation===true?{cessation_at:event.at}:{})});
 attempt.late_ack_unresolved=true;
 attempt.cleanup_proven=false;
 attempt.cleanup_proof_persisted_at=null;
 for(const resource of attempt.resources){
  if(original?.pending_late_exposure||state.attempts.some(row=>row.id!==attempt.id&&originalAttempt(row,state)?.id===original?.id&&row.resources.some(r=>r.held_micro>0||r.unrepresented_micro>0)))continue;
  resource.held_micro+=resource.released_micro;
  resource.released_micro=0;
 }
 const token=state.opening_tokens.find(t=>t.account_week_id===attempt.account_week_id);
 if(token&&attempt.opening){token.status='consumed';token.attempt_id=attempt.id;}
 attempt.cessation_proven=false;
 attempt.process_state='unknown';
}

function openingSourceAttempt(state,attempt) {
 if(attempt.opening)return attempt;
 if(!state)return null;
 const opened=state.opened_windows.find(record=>record.account_week_id===attempt.account_week_id&&
  attempt.resources.some(resource=>resource.kind==='short'&&resource.id===record.resource_id&&
   resource.instance===record.instance&&resource.epoch===record.epoch&&
   resource.anchor_at===record.anchor_at&&resource.resets_at===record.resets_at));
 if(!opened)return null;
 const source=state.attempts.find(candidate=>candidate.id===opened.attempt_id);
 return source?.opening?.confirmed?source:null;
}

function attemptClosureDeadline(attempt,state=null,additionalResources=[]) {
 const opening=openingSourceAttempt(state,attempt);
 if(opening)return [...opening.resources,...attempt.resources,...additionalResources].reduce((earliest,r)=>{
  const boundary=BigInt(r.resets_at);
  return earliest===null||boundary<earliest?boundary:earliest;
 },null);
 return attempt.resources.reduce((earliest,r)=>{
  const boundary=BigInt(r.resets_at);
  return earliest===null||boundary<earliest?boundary:earliest;
 },null);
}

function attemptFitsRemainingMargin(attempt,at,state=null) {
 return BigInt(at)+BigInt(attempt.wall_ms)+BigInt(attempt.stop_ms)+
  BigInt(attempt.uncertainty_ms)<=attemptClosureDeadline(attempt,state);
}

function resourceIdentityKey(resource) {
 return [resource.id,resource.instance,resource.epoch,resource.anchor_at,resource.resets_at].join('\u0000');
}

function crossResetRecoveryProblem(state,attempt,event) {
 // Old charges stay in their original point units; current rows carry direct
 // charges and conversions for their own exact resource scopes. Never rescale.
 const keys=['type','event_id','at','attempt_id','settlement_id','previous_settlement_id','observed_at',
  'account','account_week_id','authoritative_cessation','usage_reconciled','complete','compatible',
  'refresh_succeeded','attribution_confirmed','resource_ids','old_charges','resources'];
 if(attempt?.resources.some(r=>r.conversion==='native_window'))return 'cross_reset_native_unsupported';
 if(!attempt||!attempt.late_ack_unresolved||!onlyKeys(event,keys)||
   !nonempty(event.settlement_id)||event.account!==state.account||
   event.account_week_id!==attempt.account_week_id||event.authoritative_cessation!==true||
   event.usage_reconciled!==true||event.complete!==true||event.compatible!==true||
   event.refresh_succeeded!==true||event.attribution_confirmed!==true||
   !safeNat(event.observed_at)||event.observed_at>event.at||
   BigInt(event.at)-BigInt(event.observed_at)>60000n||
   !attempt.resources.some(resource=>event.observed_at>=resource.resets_at)||
   attempt.recoveries.some(recovery=>recovery.settlement_id===event.settlement_id))
  return 'cross_reset_reconciliation_incomplete';
 const previous=attempt.recoveries.at(-1)??null;
 if(event.previous_settlement_id!==(previous?.settlement_id??null))return 'cross_reset_settlement_order';
 if(!Array.isArray(event.old_charges)||event.old_charges.length!==attempt.resources.length||
   !Array.isArray(event.resources)||event.resources.length===0||
   !Array.isArray(event.resource_ids)||event.resource_ids.length!==event.resources.length||
   new Set(event.resource_ids).size!==event.resource_ids.length)return 'cross_reset_reconciliation_incomplete';
 const oldCharges=new Map();
 for(const old of event.old_charges){
  if(!record(old)||!onlyKeys(old,['id','instance','epoch','kind','anchor_at','resets_at',
    'kappa_micro','charged_micro']))return 'cross_reset_resource_mapping';
  const source=attempt.resources.find(resource=>sameResourceScope(resource,old));
  if(!source||old.kind!==source.kind||old.kappa_micro!==source.kappa_micro||
    !safeNat(old.charged_micro)||old.charged_micro>source.initial_micro||
    BigInt(old.charged_micro)<BigInt(source.spent_micro)+BigInt(source.settled_micro)||
    oldCharges.has(resourceIdentityKey(source)))return 'cross_reset_resource_mapping';
  oldCharges.set(resourceIdentityKey(source),old);
 }
 if(oldCharges.size!==attempt.resources.length)return 'cross_reset_resource_mapping';
 const currentIds=new Set(),currentScopes=new Set(),mappedSources=new Set();
 for(let i=0;i<event.resources.length;i++){
  const resource=event.resources[i];
  if(!record(resource)||!onlyKeys(resource,['id','instance','epoch','kind','anchor_at','resets_at',
    'duration_ms','baseline_used_micro','used_micro','kappa_micro','charged_micro',
    'cumulative_charged_micro','source_resource_ids'])||
    !['anchor_at','resets_at','duration_ms','baseline_used_micro','used_micro','kappa_micro',
     'charged_micro','cumulative_charged_micro'].every(key=>safeNat(resource[key]))||
    !nonempty(resource.id)||!nonempty(resource.instance)||!nonempty(resource.epoch)||
    !['weekly','short','model'].includes(resource.kind)||resource.kappa_micro===0||
    resource.duration_ms===0||BigInt(resource.resets_at)-BigInt(resource.anchor_at)!==BigInt(resource.duration_ms)||
    event.observed_at<resource.anchor_at||event.observed_at>=resource.resets_at||
    resource.baseline_used_micro>Number(PACE50_HUNDRED)||resource.used_micro>Number(PACE50_HUNDRED)||
    event.resource_ids[i]!==resource.id||currentIds.has(resource.id)||
    currentScopes.has(resourceIdentityKey(resource))||!Array.isArray(resource.source_resource_ids)||
    resource.source_resource_ids.length===0)return 'cross_reset_resource_mapping';
  const sourceKeys=new Set();
  let exactScopeOldCharge=0n;
  for(const source of resource.source_resource_ids){
   if(!record(source)||!onlyKeys(source,['id','instance','epoch','anchor_at','resets_at']))
    return 'cross_reset_resource_mapping';
   const old=attempt.resources.find(candidate=>sameResourceScope(candidate,source));
   if(!old||old.kind!==resource.kind)return 'cross_reset_resource_mapping';
   const sourceKey=resourceIdentityKey(old);
   if(sourceKeys.has(sourceKey))return 'cross_reset_resource_mapping';
   sourceKeys.add(sourceKey);mappedSources.add(sourceKey);
   if(sameResourceScope(old,resource))exactScopeOldCharge+=asMicro(oldCharges.get(sourceKey).charged_micro);
  }
  let previousCharge=0n;
  for(const recovery of attempt.recoveries)for(const old of recovery.resources)
   if(sameResourceScope(old,resource))previousCharge+=asMicro(old.charged_micro);
  const cumulative=previousCharge+asMicro(resource.charged_micro);
  const watermark=aggregateWatermark(state,resource);
  if(cumulative>BigInt(Number.MAX_SAFE_INTEGER)||
    BigInt(resource.cumulative_charged_micro)!==cumulative||
    BigInt(resource.baseline_used_micro)+exactScopeOldCharge+cumulative>BigInt(resource.used_micro)||
    watermark&&(event.observed_at<watermark.observed_at||resource.used_micro<watermark.used_micro))
   return 'cross_reset_reconciliation_mismatch';
  const original=attempt.resources.find(old=>sameResourceScope(old,resource));
  if(original&&resource.baseline_used_micro!==original.baseline_used_micro)
   return 'cross_reset_reconciliation_mismatch';
  currentIds.add(resource.id);currentScopes.add(resourceIdentityKey(resource));
 }
 if(event.resources.some(resource=>resource.source_resource_ids.some(source=>
   !attempt.resources.some(old=>sameResourceScope(old,source)))))return 'cross_reset_resource_mapping';
 if(attempt.resources.some(resource=>!mappedSources.has(resourceIdentityKey(resource))))
  return 'cross_reset_resource_mapping';
 return null;
}

// Account feedback remains accepted, but must leave released attempts untouched.
// Every other event needs an explicit decision before it can affect a released attempt.
export const OWNER_RELEASE_EVENT_POLICY=Object.freeze({
 meter_feedback:'skip_released',
 meter_feedback_pending:'skip_released',
 meter_feedback_covered:'allow',
 served_model:'allow',
 advance_account_week:'allow',
 owner_return:'allow',
 owner_absent:'allow',
 pause:'allow',
 stop:'allow',
 owner_stop:'allow',
 on:'allow',
 late_ack:'refuse',
 launch_result:'refuse',
 opening_confirmed:'refuse',
 late_exposure_carried:'refuse',
 usage:'refuse',
 reconcile_burn:'refuse',
 cross_reset_reconciled:'refuse',
 cessation_proven:'refuse',
 owner_release_hold:'refuse',
 cleanup_proven:'allow',
 native_meter_settled:'refuse',
 usage_covered:'refuse',
 usage_represented:'allow',
 usage_unknown:'allow',
 late_start_carried:'allow',
 legacy_cleanup_full_charge:'allow',
 window_reset_settled:'allow',
 opening_not_occurred:'allow',
});

/**
 * Apply durable policy events as values. Effects are instructions for the
 * runtime adapter, not claims that a process stopped or a provider was read.
 */
export function transitionEstimatedPace50State(state,event,{postingLagBoundMs=MEASURED_POSTING_LAG_MS}={}) {
 if(!validPace50State(state))return transitionResult(state,event,'state_unknown');
 if(!record(event)||!nonempty(event.event_id)||!safeNat(event.at))return transitionResult(state,event,'invalid_event');
 if(state.event_ids.includes(event.event_id))return transitionResult(state,event,'duplicate_event');
 if(state.updated_at!==null&&event.at<state.updated_at)return transitionResult(state,event,'event_order');
 if(state.revision===Number.MAX_SAFE_INTEGER)return transitionResult(state,event,'revision_overflow');
 const next=structuredClone(state),effects=[];
 const attempt=nonempty(event.attempt_id)?next.attempts.find(a=>a.id===event.attempt_id):null;
 const fail=(reason)=>transitionResult(state,event,reason);

 if(attempt&&state.event_ids.includes(`${attempt.id}:owner-release-hold`)&&
   !['allow','skip_released'].includes(OWNER_RELEASE_EVENT_POLICY[event.type]))
  return fail('manual_full_charge_pending');

 if(['meter_feedback','meter_feedback_pending'].includes(event.type)){
  if(event.account!==state.account||!Array.isArray(event.resources)||!event.resources.length||
    !event.resources.every(validFeedbackRate)||(event.type==='meter_feedback'&&
    (!safeNat(event.observed_at)||event.observed_at>event.at||event.at-event.observed_at>60000)))return fail('meter_feedback_invalid');
  const rates=new Map((state.rate_feedback?.rates??[]).map(r=>[resourceIdentityKey(r),r]));
  const pending=new Map(pendingFeedback(state.rate_feedback??{blocked:false,rates:[]}).map(r=>[resourceIdentityKey(r),r]));
  for(const r of event.resources){
   const prior=rates.get(resourceIdentityKey(r));
   rates.set(resourceIdentityKey(r),{...r,kappa_micro:Math.max(r.kappa_micro,prior?.kappa_micro??0),
    used_micro:Math.max(r.used_micro,prior?.used_micro??0)});
   pending.set(resourceIdentityKey(r),{...rates.get(resourceIdentityKey(r)),required_at:event.at});
  }
  next.rate_feedback={blocked:true,required_at:event.at,covered_at:null,rates:[...rates.values()],pending:[...pending.values()]};
  for(const a of next.attempts){
   if(state.event_ids.includes(`${a.id}:owner-release-hold`))continue;
   let affected=false;
   for(const ledger of a.resources){
    const rate=pending.get(resourceIdentityKey(ledger));
    // A native-window hold is already in window points. A conversion surprise does not reprice it.
    if(!rate||ledger.conversion==='native_window'||ledger.held_micro===0&&ledger.unrepresented_micro===0)continue;
    affected=true;
    // Reprice only outstanding native exposure. Represented and pending burns remain intact.
    const kappa=Math.max(rate.kappa_micro,ledger.kappa_micro);
    const exposure=repricedCommitmentMicro(ledger,kappa);
    if(!safeNat(exposure))return fail('meter_feedback_overflow');
    const held=BigInt(exposure)-BigInt(ledger.unrepresented_micro);
    const initial=BigInt(ledger.initial_micro)+held-BigInt(ledger.held_micro);
    if(initial>BigInt(Number.MAX_SAFE_INTEGER))return fail('meter_feedback_overflow');
    ledger.initial_micro=Number(initial);ledger.held_micro=Number(held);ledger.kappa_micro=kappa;
   }
   if(affected&&a.process_state!=='ceased'){
    const pending=a.process_state==='not_started';
    a.process_state=pending?'cancel_requested':'cessation_requested';
    effects.push({type:'request_cessation',attempt_id:a.id,reason:'provider_limit'});
   }
  }
 }else if(event.type==='meter_feedback_covered'){
  const feedback=state.rate_feedback;
  if(!feedback?.blocked||event.account!==state.account||event.complete!==true||event.refresh_succeeded!==true||
    !safeNat(event.observed_at)||event.observed_at>event.at||event.at-event.observed_at>60000||
    !Array.isArray(event.resources))return fail('meter_coverage_required');
  const pending=pendingFeedback(feedback),remaining=[];
  let liabilityUnreconciled=false;
  for(const rate of pending){
   const seen=event.resources.find(r=>r.id===rate.id),watermark=aggregateWatermark(state,rate);
   // A provider refresh proves only its own roster. Missing resources stay pending;
   // they do not invalidate independently verified coverage for another resource.
   if(!seen||event.observed_at<rate.required_at){remaining.push(rate);continue;}
   const affected=state.attempts.filter(a=>a.resources.some(r=>sameResourceScope(r,rate)));
   if(affected.some(a=>a.process_state!=='ceased'||a.resources.some(r=>sameResourceScope(r,rate)&&
     (r.held_micro>0||r.unrepresented_micro>0))||
     (a.cleanup_proof_persisted_at??0)>event.observed_at||a.resources.some(r=>sameResourceScope(r,rate)&&
     r.burns.some(b=>b.at>event.observed_at)))){
    remaining.push(rate);liabilityUnreconciled=true;continue;
   }
   if(!safeNat(seen.used_micro)||seen.used_micro>Number(PACE50_HUNDRED)||
     !(sameResourceScope(seen,rate)&&seen.used_micro>=rate.used_micro&&
       (!watermark||seen.used_micro>=watermark.used_micro&&event.observed_at>=watermark.observed_at)||
       safeNat(seen.anchor_at)&&seen.anchor_at>=rate.resets_at&&event.observed_at>=seen.anchor_at))remaining.push(rate);
  }
  if(remaining.length===pending.length)return fail(liabilityUnreconciled?'meter_liability_unreconciled':'meter_coverage_required');
  // covered_at is the time the last independently verified pending resource cleared.
  next.rate_feedback={...feedback,pending:remaining,blocked:remaining.length>0,
   covered_at:remaining.length?null:event.at};
 }else if(event.type==='served_model'){
  // Additive evidence only: the caller reuses the current accounting watermark,
  // and this event has no admission, process, resource or provider-facing effects.
  if(!attempt||event.at!==state.updated_at||!validServedModel(event.served_model))return fail('served_model_invalid');
  attempt.served_model=mergeServedModelEvidence(attempt.served_model,event.served_model);
 }else if(event.type==='advance_account_week'){
  if(event.account!==state.account||!nonempty(event.account_week_id)||event.account_week_id===state.account_week_id||
    event.account_week_mapping_known!==true||!nonempty(event.weekly_account_id)||!nonempty(event.weekly_resource_id)||
    !safeNat(event.weekly_resets_at)||event.weekly_resets_at<=event.at||
    event.account_week_id!==`${event.weekly_account_id}:weekly:${event.weekly_resets_at}`)return fail('account_week_identity');
  const weeks=providerWeeks(state),current=weeks[event.weekly_resource_id];
  // Each provider's weekly meter only moves forward. A week another meter holds, or a week of this meter that does not
  // reset later than the meter's latest verified week, is refused; returning to the meter's latest week is allowed.
  if(Object.entries(weeks).some(([id,row])=>id!==event.weekly_resource_id&&row.account_week_id===event.account_week_id)||
    current!==undefined&&(current.account_week_id===event.account_week_id?current.resets_at!==event.weekly_resets_at
      :current.resets_at>=event.weekly_resets_at))return fail('account_week_identity');
  next.provider_weeks={...weeks,[event.weekly_resource_id]:
   {account_week_id:event.account_week_id,resets_at:event.weekly_resets_at}};
  next.account_week_id=event.account_week_id;
  if(!next.opening_tokens.some(t=>t.account_week_id===event.account_week_id))
   next.opening_tokens.push({account_week_id:event.account_week_id,status:'unused',attempt_id:null});
 }else if(event.type==='owner_return'){
  next.owner_present=true;next.owner_absent_since=null;effects.push({type:'stop_admissions'});
  for(const a of next.attempts){
   if(a.process_state==='ceased')continue;
   if(a.process_state==='not_started')a.process_state='cancel_requested';
   else a.process_state='cessation_requested';
   effects.push({type:a.process_state==='cancel_requested'?'cancel_pending_attempt':'request_cessation',
    attempt_id:a.id,reason:'owner_return'});
  }
 }else if(event.type==='owner_absent'){
  if(event.confirmed!==true)return fail('absence_unconfirmed');
  next.owner_present=false;next.owner_absent_since=event.at;
  effects.push({type:'require_fresh_admission_checks'});
 }else if(event.type==='pause'){
  next.mode='paused';effects.push({type:'freeze_new_chunks'});
  for(const a of next.attempts)if(a.process_state==='not_started'){
   a.process_state='cancel_requested';
   effects.push({type:'cancel_pending_attempt',attempt_id:a.id,reason:'pause'});
  }
 }else if(event.type==='stop'){
  next.mode='off';effects.push({type:'stop_admissions'});
  for(const a of next.attempts){
   if(a.process_state==='ceased')continue;
   if(a.process_state==='not_started')a.process_state='cancel_requested';
   else a.process_state='cessation_requested';
   effects.push({type:a.process_state==='cancel_requested'?'cancel_pending_attempt':'request_cessation',
    attempt_id:a.id,reason:'stop'});
  }
 }else if(event.type==='owner_stop'){
  if(!attempt||!(['not_started','running','unknown','cancel_requested','cessation_requested'].includes(attempt.process_state)||settling(attempt)))
   return fail('owner_stop_invalid');
  // This accepted request travels with the attempt across restarts; it is not cessation evidence.
  attempt.owner_stop={event_id:event.event_id,requested_at:event.at,durable_intent_recorded:true};
  next.mode='off';effects.push({type:'stop_admissions'});
  // The effect that stops the attempt travels with the durable intent, so a failed route call cannot leave the run going. A settling
  // attempt's sandbox is already gone, so its cessation record stays as it is.
  if(attempt.process_state==='not_started'||attempt.process_state==='cancel_requested'){
   if(attempt.process_state==='not_started')attempt.process_state='cancel_requested';
   effects.push({type:'cancel_pending_attempt',attempt_id:attempt.id,reason:'owner_stop'});
  }else if(attempt.process_state!=='ceased'){
   attempt.process_state='cessation_requested';
   effects.push({type:'request_cessation',attempt_id:attempt.id,reason:'owner_stop'});
  }
 }else if(event.type==='on'){
  next.mode='on';effects.push({type:'require_fresh_admission_checks'});
 }else if(event.type==='late_ack'){
  if(!attempt)return fail('late_ack_invalid');
  markLateAcknowledgement(next,attempt,event);
  if(attempt.launch_state==='reserved')attempt.launch_state='ambiguous';
  effects.push({type:'request_cessation',attempt_id:attempt.id,reason:'late_ack_unresolved'},
   {type:'retain_reservation_and_opening_token',attempt_id:attempt.id},
   {type:'request_fresh_complete_reconciliation',attempt_id:attempt.id});
 }else if(event.type==='launch_result'){
  const lateStarted=attempt&&event.result==='started'&&
   (attempt.launch_state==='started'||attempt.process_state==='ceased');
  if(!attempt||!['started','ambiguous','failed'].includes(event.result)||
    (!lateStarted&&(!['reserved','ambiguous','failed'].includes(attempt.launch_state)||
     attempt.process_state==='ceased')))return fail('launch_receipt_invalid');
  if(lateStarted){
   attempt.launch_state='started';markLateAcknowledgement(next,attempt,event);
   effects.push({type:'request_cessation',attempt_id:attempt.id,reason:'late_start_ack'},
    {type:'retain_reservation_and_opening_token',attempt_id:attempt.id},
    {type:'request_fresh_complete_reconciliation',attempt_id:attempt.id});
  }else if(event.result==='started'){
   const late=attempt.launch_state!=='reserved'||attempt.late_ack_unresolved||
    ['cancel_requested','cessation_requested'].includes(attempt.process_state)||
    attempt.opening!==null&&!attempt.opening.confirmed||!attemptFitsRemainingMargin(attempt,event.at,next);
   attempt.launch_state='started';
   if(late){
    markLateAcknowledgement(next,attempt,event);
    effects.push({type:'request_cessation',attempt_id:attempt.id,reason:'late_start_ack'},
     {type:'retain_reservation_and_opening_token',attempt_id:attempt.id},
     {type:'request_fresh_complete_reconciliation',attempt_id:attempt.id});
   }else if(state.mode!=='on'||state.owner_present&&attempt.owner_presence_override!==true||
     ['cancel_requested','cessation_requested'].includes(attempt.process_state)){
    attempt.process_state='cessation_requested';
    effects.push({type:'request_cessation',attempt_id:attempt.id,reason:'control_changed_before_start'});
   }else attempt.process_state='running';
  }else{
   attempt.launch_state=event.result==='failed'?'failed':'ambiguous';
   const cancellationRequested=state.mode!=='on'||state.owner_present||
    ['cancel_requested','cessation_requested'].includes(attempt.process_state);
   attempt.process_state='unknown';effects.push({type:'retain_reservation_and_opening_token',attempt_id:attempt.id});
   if(cancellationRequested)effects.push({type:'request_cessation',attempt_id:attempt.id,
    reason:'control_changed_during_launch'});
  }
 }else if(event.type==='opening_confirmed'){
  if(!attempt||!attempt.opening||attempt.opening.confirmed||
    event.authoritative_opened!==true||event.account!==state.account||
    event.account_week_id!==attempt.account_week_id||event.epoch!==attempt.epoch||
    event.resource_id!==attempt.opening.resource_id||event.instance!==attempt.opening.instance||
    event.anchor_at!==attempt.opening.anchor_at||event.resets_at!==attempt.opening.resets_at||
    !safeNat(event.observed_at)||event.observed_at<attempt.opening.anchor_at||
    event.observed_at>=attempt.opening.resets_at||event.observed_at>event.at||
    BigInt(event.at)-BigInt(event.observed_at)>60000n)return fail('opening_confirmation_invalid');
  const token=next.opening_tokens.find(t=>t.account_week_id===attempt.account_week_id);
  const contradictedNoOpenProof=token?.status==='unused'&&nonempty(token.last_proof_id);
  if(!token||(!(token.status==='consumed'&&token.attempt_id===attempt.id)&&!contradictedNoOpenProof))
   return fail('opening_token_not_reserved');
  const duplicate=next.opened_windows.some(w=>w.account_week_id===event.account_week_id);
  if(duplicate)return fail('opening_already_recorded');
  token.status='consumed';token.attempt_id=attempt.id;
  attempt.opening.confirmed=true;
  next.opened_windows.push({account_week_id:event.account_week_id,resource_id:event.resource_id,
   instance:event.instance,epoch:event.epoch,anchor_at:event.anchor_at,resets_at:event.resets_at,
   attempt_id:attempt.id});
  if(settling(attempt)){
   // The sandbox is already gone. The window is recorded above; nothing may launch, cancel or reopen the process.
  }else if(BigInt(event.at)>attemptClosureDeadline(attempt,next)||contradictedNoOpenProof||
    attempt.launch_state!=='reserved'||(attempt.process_state==='ceased'&&!settling(attempt))){
   markLateAcknowledgement(next,attempt,event);
   effects.push({type:'request_cessation',attempt_id:attempt.id,reason:'late_opening_ack'},
    {type:'retain_reservation_and_opening_token',attempt_id:attempt.id},
    {type:'request_fresh_complete_reconciliation',attempt_id:attempt.id});
  }else if(attempt.late_ack_unresolved){
   effects.push({type:'request_cessation',attempt_id:attempt.id,reason:'late_ack_unresolved'},
    {type:'retain_reservation_and_opening_token',attempt_id:attempt.id},
    {type:'request_fresh_complete_reconciliation',attempt_id:attempt.id});
  }else if(!attemptFitsRemainingMargin(attempt,event.at,next)){
   attempt.process_state='cancel_requested';
   effects.push({type:'cancel_pending_attempt',attempt_id:attempt.id,
    reason:'insufficient_opening_margin'},
    {type:'retain_reservation_and_opening_token',attempt_id:attempt.id});
  }else if(state.mode!=='on'||state.owner_present&&attempt.owner_presence_override!==true||
    ['cancel_requested','cessation_requested'].includes(attempt.process_state)){
   attempt.process_state='cancel_requested';
   effects.push({type:'cancel_pending_attempt',attempt_id:attempt.id,reason:'control_changed_before_launch'});
  }else{
   effects.push({type:'launch_chunk',attempt_id:attempt.id});
  }
 }else if(event.type==='late_exposure_carried'){
  const pending=attempt?.pending_late_exposure;
  if(!pending||event.identity_verified!==true||event.account!==attempt.account||event.complete!==true||event.refresh_succeeded!==true||
    !nonempty(event.epoch)||!nonempty(event.account_week_id)||!safeNat(event.observed_at)||event.observed_at>event.at||event.at-event.observed_at>60000||
    !Array.isArray(event.resources))return fail('late_generation_invalid');
  const resources=[];
  for(const old of attempt.resources){
   if(settlementEligibility(attempt,old,{state:next,evidence:event,at:event.at,postingLagBoundMs}).reason!=='retain')continue;
   const matches=event.resources.filter(r=>r.id===old.id&&r.kind===old.kind);
   if(matches.length!==1)return fail('late_generation_invalid');
   const cur=matches[0];
   if(!safeNat(cur.anchor_at)||!safeNat(cur.resets_at)||!safeNat(cur.duration_ms)||cur.duration_ms===0||
     cur.resets_at-cur.anchor_at!==cur.duration_ms||cur.anchor_at>event.observed_at||cur.resets_at<=event.at||
     !safeNat(cur.used_micro)||cur.used_micro>Number(PACE50_HUNDRED)||!nonempty(cur.instance)||cur.epoch!==event.epoch)return fail('late_generation_invalid');
   const ceased=durableCessationBound(attempt,{state:next});
   if(ceased!==null&&cur.anchor_at>ceased)return fail('late_generation_not_covering');
   const native=old.conversion==='native_window';
   if(!native&&(!safeNat(cur.kappa_micro)||cur.kappa_micro===0))return fail('late_generation_invalid');
   const maximum=native?BigInt(old.initial_micro):(BigInt(old.initial_micro)*BigInt(cur.kappa_micro)+BigInt(old.kappa_micro)-1n)/BigInt(old.kappa_micro);
   if(maximum<=0n||maximum>PACE50_HUNDRED)return fail('late_generation_invalid');
   resources.push({...structuredClone(old),instance:cur.instance,epoch:cur.epoch,anchor_at:cur.anchor_at,resets_at:cur.resets_at,
    duration_ms:cur.duration_ms,baseline_used_micro:cur.used_micro,aggregate_observed_at:event.observed_at,aggregate_used_micro:cur.used_micro,
    initial_micro:Number(maximum),spent_micro:0,settled_micro:0,held_micro:Number(maximum),released_micro:0,unrepresented_micro:0,burns:[],
    ...(native?{}:{kappa_micro:cur.kappa_micro})});
   const installed=resources.at(-1);
   delete installed.usage_covered_at;delete installed.native_release_used_micro;delete installed.skipped_periods;
   if(old.cold_open||old.cold_provenance){delete installed.cold_open;installed.cold_provenance=true;}
  }
  if(!resources.length)return fail('late_generation_unnecessary');
  const id=`${attempt.id}:generation:${pending.event_id}`;
  if(next.attempts.some(a=>a.id===id))return fail('late_generation_duplicate');
  if(resources.length)next.attempts.push({id,lineage_parent_id:attempt.id,account:attempt.account,account_week_id:event.account_week_id,epoch:event.epoch,
   job_id:attempt.job_id,...(attempt.price_rev?{price_rev:attempt.price_rev}:{}),created_at:event.at,
   wall_ms:attempt.wall_ms,stop_ms:attempt.stop_ms,uncertainty_ms:attempt.uncertainty_ms,
   launch_state:'started',process_state:'unknown',cessation_proven:false,cleanup_proven:false,hold_closed:false,
   late_ack_unresolved:false,late_ack_events:[],opening:null,recoveries:[],usage_unknown:null,resources});
  delete attempt.pending_late_exposure;resolveLateExposure(attempt,event);
 }else if(event.type==='usage'){
  if(!attempt||!nonempty(event.burn_id)||!Array.isArray(event.resources)||!event.resources.length||
    !(['running','cessation_requested','cancel_requested','unknown'].includes(attempt.process_state)||settling(attempt)))
   return fail('usage_event_invalid');
  if(next.attempts.some(a=>a.id!==attempt.id&&a.resources.some(r=>r.burns.some(b=>b.id===event.burn_id))))
   return fail('burn_id_reused');
  const maximumAfterCleanup=event.maximum_after_cleanup===true;
  if(maximumAfterCleanup&&(!settling(attempt)||attempt.cleanup_proven!==true||
    !safeNat(attempt.cleanup_proof_persisted_at)))return fail('usage_event_invalid');
  const burnAt=maximumAfterCleanup?attempt.cleanup_proof_persisted_at:event.at;
  const byId=new Map(event.resources.map(r=>[r?.id,r]));
  if(byId.size!==attempt.resources.length||attempt.resources.some(r=>!byId.has(r.id)))return fail('usage_vector_incomplete');
  for(const ledger of attempt.resources){
   const used=byId.get(ledger.id);
   if(!record(used)||!onlyKeys(used,['id','instance','amount_micro'])||
     used.instance!==ledger.instance||!safeNat(used.amount_micro)||used.amount_micro===0||used.amount_micro>ledger.held_micro||
     ledger.burns.some(b=>b.id===event.burn_id)||maximumAfterCleanup&&used.amount_micro!==ledger.held_micro)return fail('usage_vector_invalid');
   if(event.at<ledger.anchor_at||event.at>=ledger.resets_at)return fail('usage_outside_resource_instance');
  }
  for(const ledger of attempt.resources){
   const used=byId.get(ledger.id);
   ledger.held_micro-=used.amount_micro;ledger.spent_micro+=used.amount_micro;
   ledger.unrepresented_micro+=used.amount_micro;
   ledger.burns.push({id:event.burn_id,amount_micro:used.amount_micro,at:burnAt,represented:false});
  }
 }else if(event.type==='reconcile_burn'){
  if(!attempt||!nonempty(event.burn_id)||event.account!==state.account||
    event.epoch!==attempt.epoch||event.complete!==true||event.compatible!==true||
    event.refresh_succeeded!==true||event.attribution_confirmed!==true||
    !safeNat(event.observed_at)||event.observed_at>event.at||
    BigInt(event.at)-BigInt(event.observed_at)>60000n||!Array.isArray(event.resources))
   return fail('reconciliation_unknown');
  // A reset window with no remaining exposure is finished. Requiring its old
  // instance in a later complete reading makes the still-open weekly burn impossible to cover.
  const ledgers=attempt.resources.filter(r=>!(attempt.cleanup_proven===true&&
    r.resets_at<=event.observed_at&&r.held_micro===0&&r.unrepresented_micro===0));
  const byId=new Map(event.resources.map(r=>[r?.id,r]));
  if(byId.size!==ledgers.length||ledgers.some(r=>!byId.has(r.id)))return fail('reconciliation_incomplete');
  for(const ledger of ledgers){
   const reading=byId.get(ledger.id),burn=ledger.burns.find(b=>b.id===event.burn_id);
   const watermark=aggregateWatermark(state,ledger);
   const required=aggregateRequired(state,ledger,event.observed_at);
   if(!record(reading)||!onlyKeys(reading,['id','instance','anchor_at','resets_at','used_micro'])||
     reading.id!==ledger.id||reading.instance!==ledger.instance||reading.anchor_at!==ledger.anchor_at||
     reading.resets_at!==ledger.resets_at||!safeNat(reading.used_micro)||
     reading.used_micro>Number(PACE50_HUNDRED)||!burn||burn.represented||
     event.observed_at<ledger.anchor_at||event.observed_at>=ledger.resets_at||
     watermark&&(event.observed_at<watermark.observed_at||reading.used_micro<watermark.used_micro)||
     burn.at>event.observed_at||required===null||BigInt(reading.used_micro)<required)
    return fail('reconciliation_mismatch');
  }
  // Attribution identifies a meter movement, not the end of provider posting for this attempt.
  // No provider supplies a coverage watermark, so this aggregate cannot release unresolved use.
  return fail('usage_coverage_unavailable');
 }else if(event.type==='cross_reset_reconciled'){
  const problem=crossResetRecoveryProblem(state,attempt,event);
  if(problem)return fail(problem);
  const recovery={settlement_id:event.settlement_id,event_id:event.event_id,
   previous_settlement_id:event.previous_settlement_id,at:event.at,observed_at:event.observed_at,
   old_charges:structuredClone(event.old_charges),resource_ids:[...event.resource_ids],
   resources:structuredClone(event.resources)};
  for(const old of recovery.old_charges){
   const ledger=attempt.resources.find(resource=>sameResourceScope(resource,old));
   // Aggregate attribution cannot settle a resource whose own window is still open.
   if(event.observed_at<ledger.resets_at)continue;
   if(!coldWindowResetProven(attempt,ledger,event.reading,event.at))return fail('cold_window_unresolved');
   ledger.settled_micro=old.charged_micro-ledger.spent_micro;
   ledger.held_micro=0;ledger.released_micro=ledger.initial_micro-old.charged_micro;
   ledger.unrepresented_micro=0;
   for(const burn of ledger.burns)burn.represented=true;
  }
  attempt.recoveries.push(recovery);
   if(!attempt.pending_late_exposure&&attempt.resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0)){
   for(const late of attempt.late_ack_events)if(late.resolved_by===null)late.resolved_by=event.event_id;
   attempt.late_ack_unresolved=false;attempt.process_state='ceased';attempt.cessation_proven=true;attempt.hold_closed=true;
  }
  effects.push({type:'cross_reset_exposure_reconciled',attempt_id:attempt.id,
   settlement_id:event.settlement_id});
 }else if(event.type==='cessation_proven'){
  if(!attempt||event.authoritative_cessation!==true||
    !(['running','unknown','cessation_requested','cancel_requested','not_started'].includes(attempt.process_state)||settling(attempt)))
   return fail('cessation_unreconciled');
  const cleanup=attempt.cleanup_proven,cleanupAt=attempt.cleanup_proof_persisted_at;
  // Only a reserved launch that never started, with its no-use claim backed by verified cleanup or absence proof, may release.
  const neverStarted=!attempt.late_ack_unresolved&&attempt.launch_state==='reserved'&&
   (attempt.process_state==='not_started'||attempt.process_state==='cancel_requested'&&event.absence_proven===true||
    attempt.process_state==='ceased'&&attempt.cleanup_proven===true)&&
   event.zero_use_attested===true&&(attempt.cleanup_proven===true||event.absence_proven===true)&&
   attempt.resources.every(r=>r.burns.length===0&&r.unrepresented_micro===0);
  // A borrower's zero-use flag is never proof for a started attempt.
  if(event.usage_reconciled===true&&!attempt.late_ack_unresolved&&attempt.launch_state==='reserved'&&event.zero_use_attested===true&&!neverStarted)
   return fail('usage_unknown');
  // A claim of reconciled use needs a settlement the attempt's own evidence supports (a measured coverage bound or a reached deadline),
  // or proof the attempt never started. Otherwise the hold stays and the event is refused.
  const settleable=attempt.resources.every(r=>settlementEligibility(attempt,r,{state:next,evidence:event,at:event.at}).reason!=='retain');
  const lateCessation=event.usage_reconciled===true&&!neverStarted&&!settleable&&attempt.process_state!=='ceased'&&
   !attempt.late_ack_unresolved&&BigInt(event.at)>attemptClosureDeadline(attempt,next);
  if(event.usage_reconciled===true&&!neverStarted&&!settleable){
   if(lateCessation){
    markLateAcknowledgement(next,attempt,event);
    effects.push({type:'request_cessation',attempt_id:attempt.id,reason:'late_cessation_ack'},
     {type:'retain_reservation_and_opening_token',attempt_id:attempt.id},
     {type:'request_fresh_complete_reconciliation',attempt_id:attempt.id});
   }else if(attempt.resources.some(r=>r.unrepresented_micro!==0))return fail('cessation_unreconciled');
   else if(!attempt.late_ack_unresolved&&attempt.launch_state==='started'&&
     (!attempt.resources.some(r=>r.burns.some(b=>b.amount_micro>0))||attempt.resources.some(r=>r.held_micro>0)))
    return fail(attempt.resources.some(r=>r.held_micro>0)?'usage_uncovered':'usage_unknown');
   else if(!attempt.late_ack_unresolved&&attempt.launch_state!=='started')return fail('usage_unknown');
   else if(attempt.late_ack_unresolved){
    if(event.complete!==true||event.compatible!==true||event.refresh_succeeded!==true||
      !safeNat(event.observed_at)||event.observed_at>event.at||
      BigInt(event.at)-BigInt(event.observed_at)>60000n||!Array.isArray(event.resources))
     return fail('late_ack_reconciliation_incomplete');
    const lateReadings=new Map(event.resources.map(r=>[r?.id,r]));
    if(lateReadings.size!==attempt.resources.length||attempt.resources.some(r=>{
     const reading=lateReadings.get(r.id),watermark=aggregateWatermark(state,r);
     return !record(reading)||!onlyKeys(reading,['id','instance','anchor_at','resets_at','used_micro'])||
      reading.id!==r.id||reading.instance!==r.instance||reading.anchor_at!==r.anchor_at||
      reading.resets_at!==r.resets_at||!safeNat(reading.used_micro)||
      reading.used_micro>Number(PACE50_HUNDRED)||event.observed_at<r.anchor_at||
      event.observed_at>=r.resets_at||watermark&&(event.observed_at<watermark.observed_at||
       reading.used_micro<watermark.used_micro)||
      BigInt(reading.used_micro)!==BigInt(r.baseline_used_micro)+r.burns.reduce((sum,b)=>
       b.at<=event.observed_at?sum+BigInt(b.amount_micro):sum,0n);
    }))return fail('late_ack_reconciliation_mismatch');
    // Matching aggregates do not prove that the provider has posted this attempt's full interval.
    if(attempt.resources.some(r=>r.held_micro>0||r.unrepresented_micro>0))
     return fail('usage_coverage_unavailable');
    for(const ledger of attempt.resources){
     const reading=lateReadings.get(ledger.id);
     ledger.aggregate_observed_at=event.observed_at;ledger.aggregate_used_micro=reading.used_micro;
    }
   }
  }
  if(durableCessationBound(attempt,{state:next})===null){
   const unresolved=attempt.late_ack_events.filter(late=>late.resolved_by===null);
   if(unresolved.length)for(const late of unresolved)late.cessation_at=event.at;
   else markLateAcknowledgement(next,attempt,{...event,authoritative_cessation:true});
   attempt.cleanup_proven=cleanup;attempt.cleanup_proof_persisted_at=cleanupAt;
  }
  attempt.process_state='ceased';attempt.cessation_proven=true;attempt.hold_closed=false;
  if(event.usage_reconciled===true||neverStarted){
   for(const ledger of attempt.resources){
    const decision=neverStarted?{reason:'no_use'}:settlementEligibility(attempt,ledger,{state:next,evidence:event,at:event.at});
    if(decision.reason==='retain')continue;
    // A cold window settles only through its reading-backed reset proof, which this event carries none of.
    if(ledger.cold_open===true&&decision.reason!=='no_use')continue;
    const held=ledger.held_micro;
    if(decision.reason==='no_use')ledger.released_micro+=held;
    else {
     if(held>0)ledger.burns.push({id:event.event_id,amount_micro:held,at:Math.min(event.at,ledger.resets_at-1),represented:true});
     ledger.spent_micro+=held;
    }
    ledger.held_micro=0;
    ledger.unrepresented_micro=0;
    for(const burn of ledger.burns)burn.represented=true;
   }
   attempt.hold_closed=!attempt.pending_late_exposure&&attempt.resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0);
   if(attempt.hold_closed){attempt.process_state='ceased';attempt.cessation_proven=true;
   for(const late of attempt.late_ack_events)if(late.resolved_by===null)late.resolved_by=event.event_id;
   attempt.late_ack_unresolved=false;}
  }
 }else if(event.type==='owner_release_hold'){
  if(!attempt||event.confirmed!==true||event.event_id!==`${attempt.id}:owner-release-hold`)
   return fail('invalid_event');
 }else if(event.type==='cleanup_proven'){
  // This records that the backend removed this attempt's sandbox. The process has ceased: that is the durable cessation record.
  // It is not usage reconciliation and does not release the hold, which stays until the attempt's usage settles.
  if(!attempt||!event.event_id.startsWith(`${attempt.id}:cleanup-proven:`)||event.cleanup_removed!==true||
    attempt.cleanup_proven===true&&safeNat(attempt.cleanup_proof_persisted_at)||
    attempt.process_state==='ceased'&&attempt.cleanup_proven!==true&&attempt.hold_closed!==false)
   return fail('cleanup_proof_invalid');
  // The verified cleanup supplies durable cessation evidence in this same atomic transition.
  const cleanupProof={...attempt,cleanup_proven:true,cleanup_proof_persisted_at:event.at};
  if(!attempt.late_ack_unresolved&&attempt.resources.some(r=>(r.held_micro>0||r.unrepresented_micro>0)&&mayHaveSpentPast(cleanupProof,r)))
   markLateAcknowledgement(next,attempt,{...event,authoritative_cessation:true});
  attempt.cleanup_proven=true;
  // persistCleanupProof stamps this event when recording the lender's sandbox-removal proof.
  // Keep that durable proof-record time, not an inferred process-exit or usage-settlement time.
  attempt.cleanup_proof_persisted_at=event.at;
  // A late acknowledgement leaves the process unknown until a fresh proof, so only an attempt without one is ceased here.
  if(attempt.late_ack_unresolved!==true&&attempt.process_state!=='ceased'){attempt.process_state='ceased';attempt.cessation_proven=true;attempt.hold_closed=false;}
 }else if(event.type==='native_meter_settled'&&!nativeCoverageMeasured(attempt,next,event,postingLagBoundMs)){
  if(attempt?.usage_unknown==='legacy_full_charge')return fail('usage_unknown');
  // This path uses a compatible post-cleanup native observation when measured coverage is unavailable.
  if(!attempt||!attempt.resources.every(r=>r.conversion==='native_window')||!settling(attempt)||attempt.cleanup_proven!==true||
    attempt.late_ack_unresolved||event.account!==state.account||event.epoch!==attempt.epoch||event.complete!==true||
    event.compatible!==true||event.refresh_succeeded!==true||!['positive','zero','unknown'].includes(event.usage)||
    !safeNat(event.observed_at)||event.observed_at>event.at||BigInt(event.at)-BigInt(event.observed_at)>60000n||
    !safeNat(attempt.cleanup_proof_persisted_at)||event.observed_at<attempt.cleanup_proof_persisted_at+NATIVE_SETTLEMENT_DELAY_MS||
    !Array.isArray(event.resources))return fail('native_settlement_unknown');
  const ledgers=attempt.resources.filter(r=>!(event.at>=r.resets_at&&r.held_micro===0&&r.unrepresented_micro===0));
  const byId=new Map(event.resources.map(r=>[r?.id,r]));
  if(byId.size!==ledgers.length||ledgers.some(r=>!byId.has(r.id)))return fail('native_settlement_incomplete');
  for(const ledger of ledgers){
   const reading=byId.get(ledger.id),watermark=aggregateWatermark(state,ledger);
   if(!record(reading)||!onlyKeys(reading,['id','instance','anchor_at','resets_at','used_micro','uncertainty_micro','cold_open'])||
     !safeNat(reading.uncertainty_micro)||
     reading.uncertainty_micro<(ledger.meter_step_micro??PROVIDER_PERCENT_UNCERTAINTY_MICRO)||
     !sameResourceScope({...reading,epoch:ledger.epoch},ledger)||!safeNat(reading.used_micro)||
     reading.used_micro>Number(PACE50_HUNDRED)||
     event.observed_at<ledger.anchor_at||event.observed_at>=ledger.resets_at||
     watermark&&(event.observed_at<watermark.observed_at||reading.used_micro<watermark.used_micro))
    return fail('native_settlement_mismatch');
  }
  const ceased=durableCessationBound(attempt,{state:next});
  const coversClosedWindows=ceased!==null&&event.observed_at>ceased&&!attempt.pending_late_exposure&&
   ledgers.every(r=>r.kind==='weekly'||r.cold_open===true&&byId.get(r.id).cold_open===true)&&
   ledgers.some(r=>r.kind==='weekly'&&byId.get(r.id).used_micro>r.baseline_used_micro);
  if(coversClosedWindows){
   // A complete post-job provider reading is the current usage baseline.
   // Keep charged spend for strategy accounting, and release only unused reservation.
   for(const ledger of ledgers){
    const reading=byId.get(ledger.id);
    const rise=Math.max(0,reading.used_micro-ledger.baseline_used_micro);
    const additional=Math.min(ledger.held_micro,Math.max(0,rise-ledger.spent_micro-ledger.settled_micro));
    if(additional>0){
     ledger.burns.push({id:`${event.event_id}:${ledger.id}:meter-rise`,amount_micro:additional,at:event.observed_at,represented:true});
     ledger.spent_micro+=additional;
    }
    for(const burn of ledger.burns){burn.represented=true;delete burn.exposure_micro;}
    ledger.unrepresented_micro=0;
    ledger.released_micro+=ledger.held_micro-additional;
    ledger.held_micro=0;
    ledger.native_release_used_micro=reading.used_micro;
    ledger.aggregate_observed_at=event.observed_at;
    ledger.aggregate_used_micro=reading.used_micro;
    ledger.overshoot_micro=Math.max(0,rise-ledger.spent_micro-ledger.settled_micro);
    ledger.usage_covered_at??=event.observed_at;
  }
   resolveLateExposure(attempt,event);
  }else{
   let nativeChanged=false;
   for(const ledger of ledgers){
    const reading=byId.get(ledger.id);
    const rise=Math.max(0,reading.used_micro-ledger.baseline_used_micro);
    const step=reading.uncertainty_micro;
    const charge=Math.max(ledger.spent_micro,Math.min(Math.max(rise,step),ledger.initial_micro));
    const additional=charge-ledger.spent_micro;
    const overshoot=Math.max(0,rise-charge);
    // Legacy releases had no provider coverage proof. Restore them to the hold and mark every old burn unresolved.
    if(ledger.released_micro>0){ledger.held_micro+=ledger.released_micro;ledger.released_micro=0;nativeChanged=true;}
    for(const burn of ledger.burns)if(burn.represented){burn.represented=false;nativeChanged=true;}
    ledger.unrepresented_micro=Number(ledger.burns.reduce((sum,burn)=>sum+asMicro(burnExposureMicro(burn)),0n));
    if(additional>0){
     ledger.burns.push({id:`${event.event_id}:${ledger.id}:meter-rise`,amount_micro:additional,at:event.observed_at,represented:false});
     ledger.spent_micro+=additional;
     ledger.held_micro-=additional;
     ledger.unrepresented_micro+=additional;
     nativeChanged=true;
    }
    if(ledger.native_release_used_micro!==reading.used_micro||ledger.aggregate_observed_at!==event.observed_at||
      ledger.aggregate_used_micro!==reading.used_micro||ledger.overshoot_micro!==overshoot)nativeChanged=true;
    ledger.native_release_used_micro=reading.used_micro;
    ledger.aggregate_observed_at=event.observed_at;ledger.aggregate_used_micro=reading.used_micro;
    ledger.overshoot_micro=overshoot;
  }
   if(!nativeChanged)return fail('native_reading_unchanged');
  }
 }else if(['usage_covered','usage_represented','native_meter_settled'].includes(event.type)){
  if(!attempt)return fail('usage_coverage_unavailable');
  // A legacy full charge left the usage unknown; a measured native reading cannot reconcile it, as an unmeasured one cannot.
  if(event.type==='native_meter_settled'&&attempt.usage_unknown==='legacy_full_charge')return fail('usage_unknown');
  let changed=false;
  for(const ledger of attempt.resources){
   if(settlementEligibility(attempt,ledger,{state:next,evidence:event,at:event.at,postingLagBoundMs}).reason!=='usage_covered')continue;
   const reading=event.resources.find(r=>r.id===ledger.id);
   if(event.type==='usage_represented'||event.type==='native_meter_settled'&&ledger.held_micro===0&&ledger.usage_covered_at!==undefined){
    const required=aggregateRequired(next,ledger,event.observed_at);
    if(ledger.held_micro!==0||event.observed_at<ledger.aggregate_observed_at||reading.used_micro<=ledger.aggregate_used_micro||
      required===null||BigInt(reading.used_micro)<required)continue;
    for(const other of next.attempts)for(const resource of other.resources)if(sameResourceScope(resource,ledger)&&resource.held_micro===0&&
      settlementEligibility(other,resource,{state:next,evidence:event,at:event.at,postingLagBoundMs}).reason==='usage_covered')
      for(const burn of resource.burns)if(!burn.represented&&burn.at<=event.observed_at){
       resource.unrepresented_micro-=burnExposureMicro(burn);burn.represented=true;changed=true;
      }
    ledger.aggregate_observed_at=event.observed_at;ledger.aggregate_used_micro=reading.used_micro;
    continue;
   }
   if(ledger.held_micro===0&&ledger.usage_covered_at!==undefined)continue;
   const floor=ledger.spent_micro+ledger.settled_micro;
   const charge=Math.max(floor,reading.used_micro-ledger.baseline_used_micro+PROVIDER_PERCENT_UNCERTAINTY_MICRO);
   const additional=charge-floor,release=Math.max(0,ledger.held_micro-additional);
   if(additional===0&&release===0&&ledger.usage_covered_at!==undefined)continue;
   const step=ledger.conversion==='native_window'?(ledger.meter_step_micro??PROVIDER_PERCENT_UNCERTAINTY_MICRO):PROVIDER_PERCENT_UNCERTAINTY_MICRO;
   const siblings=next.attempts.flatMap(a=>a.resources.filter(r=>sameResourceScope(r,ledger)));
   const baseline=Math.min(...siblings.map(r=>r.baseline_used_micro));
   const represented=siblings.filter(r=>r!==ledger).reduce((sum,r)=>sum+Math.max(0,r.spent_micro+r.settled_micro-r.unrepresented_micro),0);
   const shown=Math.max(0,Math.min(reading.used_micro-ledger.baseline_used_micro,reading.used_micro-baseline-represented));
   const target=ledger.conversion==='native_window'?Math.max(step,ledger.unrepresented_micro):Math.max(step,charge-shown);
   // Whole-delta charges can overlap. Only the shared meter's remaining shown amount may be represented.
   let excess=Math.max(0,ledger.unrepresented_micro-target),newlyShown=0;
   for(const burn of ledger.burns)if(!burn.represented&&excess>0){
    const taken=Math.min(burn.amount_micro,excess);burn.amount_micro-=taken;
    ledger.unrepresented_micro-=taken;newlyShown+=taken;excess-=taken;
   }
   if(newlyShown>0)ledger.burns.push({id:`${event.event_id}:${ledger.id}:attributed`,amount_micro:newlyShown,at:event.observed_at,represented:true});
   const missing=Math.max(0,target-ledger.unrepresented_micro);
   let uncertainty=Math.min(additional,missing),remaining=missing-uncertainty;
   for(const burn of ledger.burns)if(burn.represented&&remaining>0){
    const taken=Math.min(burn.amount_micro,remaining);burn.amount_micro-=taken;uncertainty+=taken;remaining-=taken;
   }
   const fromAdditional=Math.min(additional,missing);
   if(additional>fromAdditional)ledger.burns.push({id:`${event.event_id}:${ledger.id}:shown`,amount_micro:additional-fromAdditional,at:event.observed_at,represented:true});
   if(uncertainty>0)ledger.burns.push({id:`${event.event_id}:${ledger.id}:uncertainty`,amount_micro:uncertainty,at:event.observed_at,represented:false,
    ...(ledger.conversion==='native_window'&&remaining>0?{exposure_micro:uncertainty+remaining}:{})});
   ledger.spent_micro+=additional;ledger.held_micro=0;ledger.released_micro+=release;
   ledger.initial_micro=ledger.spent_micro+ledger.settled_micro+ledger.released_micro;
   ledger.unrepresented_micro+=uncertainty+(ledger.conversion==='native_window'&&uncertainty>0?remaining:0);
   if(ledger.conversion==='native_window'){ledger.native_release_used_micro=reading.used_micro;ledger.overshoot_micro=0;}
   ledger.usage_covered_at??=event.observed_at;
   ledger.aggregate_observed_at=event.observed_at;ledger.aggregate_used_micro=reading.used_micro;
   changed=true;
  }
  if(!changed)return fail('usage_coverage_unavailable');
  for(const row of next.attempts)resolveLateExposure(row,event);
 }else if(event.type==='usage_unknown'){
  // The run ended without a usage reading. Its exposure stays held until the provider meter settles it, and the fact is durable.
  if(!attempt||!nonempty(event.provider)||(attempt.usage_unknown!==undefined&&attempt.usage_unknown!==null)||
    !(['running','unknown','cessation_requested','cancel_requested'].includes(attempt.process_state)||settling(attempt)))
   return fail('usage_unknown_invalid');
  attempt.usage_unknown=event.provider;
}else if(event.type==='late_start_carried'){
  // A late start's usage is unreported, so the run may have used the window that covers its start. That window carries the run's
  // maximum exposure on a record of its own, as unrepresented usage. Only a covering reading or the window's reset settles it. The late
  // flag records the start and refuses nothing.
  if(!attempt||!Array.isArray(event.carries)||!event.carries.length||
    !safeNat(event.observed_at)||event.observed_at>event.at||BigInt(event.at)-BigInt(event.observed_at)>60000n)
   return fail('late_carry_invalid');
  // Identity fields default to the attempt's own when the event names none; a cross-week carry always names them.
  const lateEpoch=event.epoch??attempt.epoch,lateWeekId=event.account_week_id??attempt.account_week_id;
  if(event.account!==undefined&&event.account!==attempt.account)return fail('late_carry_invalid');
  const weekly=attempt.resources.find(r=>r.kind==='weekly');
  const crossWeek=event.carries.some(c=>c.from_id===weekly?.id&&c.from_instance===weekly?.instance);
  if(crossWeek){
   const successor=event.carries.find(c=>c.from_id===weekly?.id&&c.from_instance===weekly?.instance)?.resource;
   const mapping=event.weekly_mapping;
   // A cold weekly successor is unsupported whatever else the event carries.
   if(record(successor)&&successor.kind!=='short'&&successor.cold_open===true)return fail('cold_window_kind_unsupported');
   // The expired weekly window determines rollover; a stable epoch cannot bypass its proof.
   // All successor liabilities are committed atomically before any ended exposure is removed.
   if(durableCessationBound(attempt,{state:next})===null||
     event.observed_at<durableCessationBound(attempt,{state:next})||event.identity_verified!==true||event.account!==attempt.account||
     event.complete!==true||event.refresh_succeeded!==true||!nonempty(lateWeekId)||
     lateWeekId===attempt.account_week_id||!nonempty(lateEpoch)||
     !weekly||!successor||skippedPeriods(weekly,successor)===null||!record(mapping)||
     mapping.account!==attempt.account||mapping.account_week_id!==lateWeekId||mapping.epoch!==lateEpoch||
     mapping.observed_at!==event.observed_at||mapping.resource_id!==successor.id||mapping.instance!==successor.instance||
     mapping.anchor_at!==successor.anchor_at||mapping.resets_at!==successor.resets_at||
     lateWeekId!==`${attempt.account}:weekly:${successor.resets_at}`||
     new Set(event.carries.map(c=>c.from_id)).size!==event.carries.length||
     event.carries.some(c=>c.resource?.epoch!==lateEpoch))return fail('late_carry_invalid');
  }
  if(!nonempty(lateEpoch)||!nonempty(lateWeekId)||
    new Set(event.carries.map(c=>c.from_id)).size!==event.carries.length||
    !crossWeek&&(lateEpoch!==attempt.epoch||lateWeekId!==attempt.account_week_id)&&
     (event.identity_verified!==true||event.account!==attempt.account||event.complete!==true||event.refresh_succeeded!==true))
   return fail('late_carry_invalid');
  // Earlier short carries have already transferred their sources to zero; only residual exposure needs a new successor.
  for(const carry of event.carries){
   const from=attempt.resources.find(r=>r.id===carry.from_id&&r.instance===carry.from_instance);
   const cur=carry.resource;
   if(from&&settlementEligibility(attempt,from,{state:next,evidence:event,at:event.at,postingLagBoundMs}).reason!=='retain')return fail('late_carry_unnecessary');
   const successorId=`${attempt.id}:carry:${carry.from_id}:${carry.from_instance}`;
   const native=from?.conversion==='native_window';
   if(!from||from.held_micro+from.unrepresented_micro===0||!record(cur)||skippedPeriods(from,cur)===null||event.at<from.resets_at||cur.kind!==from.kind||cur.instance===from.instance||
     cur.epoch!==lateEpoch||cur.anchor_at>event.observed_at||cur.resets_at<=event.observed_at||event.at>=cur.resets_at||
     !(native?true:safeNat(cur.kappa_micro)&&cur.kappa_micro!==0)||!safeNat(cur.used_micro)||cur.used_micro>Number(PACE50_HUNDRED)||
     !safeNat(cur.duration_ms)||BigInt(cur.resets_at)-BigInt(cur.anchor_at)!==BigInt(cur.duration_ms)||
     !(native||safeNat(from.kappa_micro)&&from.kappa_micro!==0)||next.attempts.some(a=>a.id===successorId))
    return fail('late_carry_invalid');
   if(cur.kind!=='short'&&cur.cold_open===true)return fail('cold_window_kind_unsupported');
   if(from.cold_open===true&&(!event.reading||event.reading.observed_at!==event.observed_at||
      !coldWindowResetProven(attempt,from,event.reading,event.at)))return fail('cold_window_unresolved');
   // The maximum is the run's reservation converted at the covering window's rate, rounded up. A native-window reservation is
   // already in this meter's points, so its maximum is the reservation itself.
   const maximum=native?asMicro(from.initial_micro)
    :(asMicro(from.initial_micro)*asMicro(cur.kappa_micro)+asMicro(from.kappa_micro)-1n)/asMicro(from.kappa_micro);
   if(maximum<=0n||maximum>PACE50_HUNDRED)return fail('late_carry_too_large');
   const charged=Number(maximum);
   // The ended window's own hold is settled as spent at its last instant, as a window reset does: the carried record now accounts
   // the run in the window that covers it, and an ended window must not stay open for admission.
   const endedHeld=from.held_micro;
   if(endedHeld>0)from.burns.push({id:`${event.event_id}:ended:${from.id}`,amount_micro:endedHeld,at:Math.min(event.at,from.resets_at-1),represented:true});
   from.spent_micro+=endedHeld;from.held_micro=0;
   for(const burn of from.burns)burn.represented=true;
   from.unrepresented_micro=0;
   next.attempts.push({id:successorId,account:attempt.account,account_week_id:crossWeek?lateWeekId:attempt.account_week_id,epoch:cur.epoch,
    job_id:attempt.job_id,...(attempt.price_rev?{price_rev:attempt.price_rev}:{}),created_at:event.at,wall_ms:attempt.wall_ms,stop_ms:attempt.stop_ms,uncertainty_ms:attempt.uncertainty_ms,
    launch_state:'started',process_state:'unknown',cessation_proven:false,cleanup_proven:attempt.cleanup_proven===true,
    ...(attempt.cleanup_proven===true?{cleanup_proof_persisted_at:event.at}:{}),
    late_ack_unresolved:false,late_ack_events:[],
    opening:null,recoveries:[],usage_unknown:null,
    resources:[{id:cur.id,instance:cur.instance,epoch:cur.epoch,kind:cur.kind,anchor_at:cur.anchor_at,resets_at:cur.resets_at,
     duration_ms:cur.duration_ms,...(from.cold_open===true||cur.cold_open===true?{cold_open:true}:{}),...(from.cold_provenance===true?{cold_provenance:true}:{}),skipped_periods:skippedPeriods(from,cur),baseline_used_micro:cur.used_micro,...(native?{conversion:'native_window',kappa_micro:null}:{kappa_micro:cur.kappa_micro}),
     aggregate_observed_at:event.observed_at,aggregate_used_micro:cur.used_micro,initial_micro:charged,spent_micro:charged,
     settled_micro:0,held_micro:0,released_micro:0,unrepresented_micro:charged,
     burns:[{id:`${successorId}:burn`,amount_micro:charged,at:event.at,represented:false}]}]});
   // The carry is created after the parent cleanup proof. Record that inherited fact for the synthetic attempt too.
   if(attempt.cleanup_proven===true)next.event_ids.push(`${successorId}:cleanup-proven:inherited:${event.event_id}`);
  }
  resolveLateExposure(attempt,event);
}else if(event.type==='legacy_cleanup_full_charge'){
  if(!attempt||attempt.cleanup_proven!==true||event.authoritative_cessation!==true)
   return fail('cleanup_proof_invalid');
  // Inferred legacy absence can read the wrong HOME. Charge the entire original
  // hold, never zero or a discounted meter amount. Open windows retain exposure
  // as an unrepresented maximum; this does not invent a provider observation.
  for(const ledger of attempt.resources){
   const charge=ledger.held_micro+ledger.released_micro;
   if(charge>0)ledger.burns.push({id:event.event_id,amount_micro:charge,
    at:Math.min(event.at,ledger.resets_at-1),represented:event.at>=ledger.resets_at});
   ledger.spent_micro+=charge;ledger.held_micro=0;ledger.released_micro=0;
   if(event.at>=ledger.resets_at){for(const burn of ledger.burns)burn.represented=true;ledger.unrepresented_micro=0;}
   else ledger.unrepresented_micro+=charge;
  }
  attempt.usage_unknown='legacy_full_charge';
  attempt.process_state='ceased';attempt.cessation_proven=true;attempt.hold_closed=true;
}else if(event.type==='window_reset_settled'){
  // The lender proved the sandbox gone, and a window this attempt held has reset. The window that reset ends its instance, so its held
  // amount is charged in full as spent. A window still open keeps the uncertainty as unrepresented exposure until a reading covers it or
  // its own reset settles it. A late resource without a carry waits until its final possible covering instance ends.
  if(!attempt||event.authoritative_cessation!==true||!Array.isArray(event.resource_ids)||!event.resource_ids.length||
    new Set(event.resource_ids).size!==event.resource_ids.length||
    !(['running','unknown','cessation_requested','cancel_requested','not_started'].includes(attempt.process_state)||settling(attempt)))
   return fail('window_reset_invalid');
  if(event.resource_ids.some(id=>{const ledger=attempt.resources.find(r=>r.id===id);return !ledger||event.at<ledger.resets_at;}))
   return fail('window_not_reset');
  if(event.resource_ids.some(id=>attempt.resources.find(r=>r.id===id)?.cold_open===true)&&
    (attempt.cleanup_proven!==true||!safeNat(attempt.cleanup_proof_persisted_at)||
     ['running','not_started'].includes(attempt.process_state)))return fail('cold_window_unresolved');
  if(event.resource_ids.some(id=>!coldWindowResetProven(attempt,
    attempt.resources.find(r=>r.id===id),event.reading,event.at)&&
    !coldWindowResetOmissionProven(attempt,attempt.resources.find(r=>r.id===id),event.reading,event.at)))
   return fail('cold_window_unresolved');
  // A listed window closes only at its durable deadline (or on measured coverage): a run cleaned up after its window reset may have spent past it.
  if(attempt.pending_late_exposure){
   // Pending exposure names no window, so it ends only when every resource has reached its deadline: every window the run
   // could have used has then ended, and no reading is needed. The released amount is restored and charged with the hold,
   // so the run is charged its full maximum.
   if(attempt.resources.some(r=>!event.resource_ids.includes(r.id)))return fail('settlement_not_eligible');
   for(const ledger of attempt.resources){ledger.held_micro+=ledger.released_micro;ledger.released_micro=0;}
   delete attempt.pending_late_exposure;
  }
  // A late start whose window ended must have its carry in the covering window before that old hold settles. Until the carry exists,
  // the hold stays open, so admission waits on the stale-exposure rule instead of granting the covering window's slack without it.
  if(attempt.late_ack_unresolved===true&&event.resource_ids.some(id=>{const ledger=attempt.resources.find(r=>r.id===id);
   return (ledger.held_micro>0||ledger.unrepresented_micro>0)&&!next.attempts.some(a=>a.id===attempt.id+':carry:'+id+':'+ledger.instance)&&
    settlementEligibility(attempt,ledger,{state:next,evidence:event,at:event.at}).reason!=='deadline_reached';}))
   return fail('late_carry_required');
  // With a durable cessation proof the listed window closes only at its deadline (the event's own authoritative_cessation flag
  // is not a proof here). An event that settles a cold window is gated by its reading-backed reset proof (checked above).
  if(durableCessationBound(attempt,{state:next})!==null&&
   event.resource_ids.some(id=>{const ledger=attempt.resources.find(r=>r.id===id);
    return ledger.cold_open!==true&&ledger.held_micro+ledger.unrepresented_micro>0&&!protectionRemovable(next,attempt,ledger,event);}))
   return fail('settlement_not_eligible');
  // An unlisted window that also reset must be retained by its own durable deadline; otherwise it belongs in the event.
  if(attempt.resources.some(l=>!event.resource_ids.includes(l.id)&&event.at>=l.resets_at&&(l.held_micro>0||l.unrepresented_micro>0)&&
   settlementEligibility(attempt,l,{state:next,evidence:event,at:event.at}).reason!=='retain'))
   return fail('window_reset_unlisted');
  for(const ledger of attempt.resources){
   // A window the run may have used past its own end keeps its hold until that window settles; any other open window carries its charge as unrepresented use.
   if(!event.resource_ids.includes(ledger.id)&&(attempt.late_ack_unresolved||attempt.pending_late_exposure||mayHaveSpentPast(attempt,ledger,{state:next})))continue;
   const charged=ledger.held_micro;
   if(event.resource_ids.includes(ledger.id)){
    // The burn is placed at the window's last instant: the instance has ended, so no later reading can revisit it.
    if(charged>0)ledger.burns.push({id:event.event_id,amount_micro:charged,at:Math.min(event.at,ledger.resets_at-1),represented:true});
    ledger.spent_micro+=charged;ledger.held_micro=0;
    for(const burn of ledger.burns)burn.represented=true;
    ledger.unrepresented_micro=0;
   }else{
    // The window is still open, so the charge stays unrepresented until a reading covers it or its own reset settles it.
    if(charged>0){ledger.burns.push({id:event.event_id,amount_micro:charged,at:event.at,represented:false});ledger.unrepresented_micro+=charged;}
    ledger.spent_micro+=charged;ledger.held_micro=0;
   }
  }
  resolveLateExposure(attempt,event);
  if(!attempt.late_ack_unresolved&&attempt.resources.every(r=>r.held_micro===0&&r.unrepresented_micro===0)){
   attempt.process_state='ceased';attempt.cessation_proven=true;attempt.hold_closed=true;
  }
}else if(event.type==='opening_not_occurred'){
  if(!attempt||!attempt.opening||attempt.opening.confirmed||event.authoritative_not_open!==true||
    event.account!==state.account||event.account_week_id!==attempt.account_week_id||
    event.epoch!==attempt.epoch||event.resource_id!==attempt.opening.resource_id||
    event.instance!==attempt.opening.instance||event.window_state!=='not_open'||
    event.anchor_at!==attempt.opening.anchor_at||event.resets_at!==attempt.opening.resets_at||
    !safeNat(event.observed_at)||event.observed_at!==event.at||
    event.observed_at<attempt.opening.anchor_at||event.observed_at>=attempt.opening.resets_at||
    !['reserved','ambiguous','failed'].includes(attempt.launch_state)||
    attempt.process_state==='running'||(attempt.process_state==='ceased'&&!settling(attempt))||
    next.opened_windows.some(w=>w.account_week_id===event.account_week_id&&
     w.resource_id===event.resource_id&&w.instance===event.instance))return fail('no_opening_proof_invalid');
  const token=next.opening_tokens.find(t=>t.account_week_id===attempt.account_week_id);
  if(!token||token.status!=='consumed'||token.attempt_id!==attempt.id)return fail('no_opening_token_match');
  token.status='unused';token.attempt_id=null;token.last_proof_id=event.event_id;
  effects.push({type:'opening_token_released_by_authoritative_no_opening_evidence',attempt_id:attempt.id});
 }else{
  return fail('unknown_event');
 }
 // Optional model evidence does not affect whether an accounting event applies.
 // Malformed metadata is ignored rather than changing settlement or admission.
 if(attempt&&['usage','usage_unknown','cessation_proven'].includes(event.type)&&validServedModel(event.served_model))
  attempt.served_model=mergeServedModelEvidence(attempt.served_model,event.served_model);
 next.revision++;
 next.updated_at=event.at;
 next.event_ids.push(event.event_id);
 return {applied:true,reason:'applied',state:next,effects:[
  {type:'persist_proposed_state',expected_revision:state.revision,next_revision:next.revision},
  ...effects]};
}

function refusePace50(reason,state=null,extra={}) {
 return {version:PACE50_VERSION,admitted:false,reason,budget_micro:0,maximum_budget_micro:0,
  requested_fits:false,windows:[],opening:null,proposed_state:state,effects:[],...extra};
}

function policyEvidenceProblem(evidence,windows) {
 if(!record(evidence))return 'evidence_unknown';
 const required={complete:'resources_incomplete',refresh_succeeded:'refresh_failed',
  subscription_only:'funding_unknown',bounded_execution:'stop_bound_unknown',
  single_executor:'executor_unknown',identity_compatible:'identity_unknown'};
 for(const [key,reason]of Object.entries(required))if(evidence[key]!==true)return reason;
 if(!Array.isArray(evidence.resource_ids))return 'resource_roster_unknown';
 const ids=evidence.resource_ids;
 if(ids.length!==windows.length||new Set(ids).size!==ids.length||
   ids.some(id=>!windows.some(w=>w?.id===id)))return 'resources_incomplete';
 return null;
}

function requestProblem(request,now) {
 if(!record(request)||!['wall_ms','stop_ms','uncertainty_ms'].every(k=>safeNat(request[k]))||
   request.wall_ms===0||typeof request.resumable!=='boolean'||
   !nonempty(request.attempt_id)||!nonempty(request.job_id)||
   !(request.expires_at===null||safeNat(request.expires_at)))return 'invalid_request';
 if(request.expires_at!==null&&BigInt(now)+BigInt(request.wall_ms)+BigInt(request.stop_ms)+
   BigInt(request.uncertainty_ms)>BigInt(request.expires_at))return 'deadline';
 return null;
}

function windowProblem(w,input,request) {
 if(!record(w)||w.account!==input.account||w.epoch!==input.epoch||
   !nonempty(w.id)||!nonempty(w.instance)||
   !['weekly','short','model'].includes(w.kind)||
   !['open','not_open','unknown'].includes(w.state)||
   !safeNat(w.anchor_at)||!safeNat(w.resets_at)||!safeNat(w.duration_ms)||w.duration_ms===0||
   BigInt(w.resets_at)-BigInt(w.anchor_at)!==BigInt(w.duration_ms)||
   !safeNat(w.observed_at)||!safeNat(w.used_micro)||w.used_micro>Number(PACE50_HUNDRED))return 'resource_unknown';
 if(w.kind!=='short'&&w.cold_open===true)return 'cold_window_kind_unsupported';
 if(!(w.conversion==='native_window'?w.kappa_micro===null:safeNat(w.kappa_micro)&&w.kappa_micro!==0))return 'conversion_unknown';
 if(w.observed_at>input.now)return 'reading_stale';
 if(w.state==='unknown')return 'reading_unknown';
 if(w.state!=='open')return 'window_not_open';
 if(w.state==='open'&&(w.anchor_at>input.now||w.resets_at<=input.now||
   w.observed_at<w.anchor_at||w.observed_at>=w.resets_at))return 'window_timing_unknown';
 if(BigInt(input.now)+BigInt(request.wall_ms)+BigInt(request.stop_ms)+
   BigInt(request.uncertainty_ms)>=BigInt(w.resets_at))return 'resource_reset_margin';
 // `cold`: a window not open yet, read as opening at the job's start (lending-pace50-source). `bound`: the window a running
 // job's cold reservation was bound to, offered only to that job's own check (lender-pace50). Neither names who opened it.
 if(w.kind==='short'&&w.state==='open'&&!['owner','lending','cold','bound'].includes(w.origin))
  return 'window_origin_unknown';
 if(w.id===input.weekly_resource_id&&w.kind!=='weekly')return 'weekly_resource_mapping';
 if(request.expires_at!==null&&request.expires_at<=input.now)return 'deadline';
 return null;
}

/**
 * Quote an ordinary or quiet-opening vector and return the proposed durable
 * transition. The caller must atomically persist proposed_state before any
 * provider opening/launch effect. This function performs neither action.
 */
export function evaluateEstimatedPace50(input) {
 if(!record(input))return refusePace50('invalid_input');
 const {now,account,epoch,account_week_id,weekly_resource_id,windows,request,controls,evidence,state}=input;
 if(!safeNat(now)||!nonempty(account)||!nonempty(epoch)||!nonempty(account_week_id)||
   !nonempty(weekly_resource_id)||!Array.isArray(windows)||windows.length===0)
  return refusePace50('invalid_identity',validPace50State(state)?state:null);
 if(!validPace50State(state))return refusePace50('state_unknown');
 if(state.account!==account||state.account_week_id!==account_week_id)return refusePace50('account_week_identity',state);
 // The current week belongs to one provider's weekly meter; a reading from another meter cannot use it.
 if(Object.entries(providerWeeks(state)).some(([id,row])=>row.account_week_id===account_week_id&&id!==weekly_resource_id))
  return refusePace50('account_week_identity',state);
 if(state.revision===Number.MAX_SAFE_INTEGER)return refusePace50('revision_overflow',state);
 if(state.updated_at!==null&&now<state.updated_at)return refusePace50('observation_order',state);
 const automatic=input.objective?.automatic!==false;
 const ownerPresenceOverride=input.owner_presence_override===true;
 const controlsOk=record(controls)&&['consent','people','agents','schedule','unexpired','on']
  .every(k=>controls[k]===true)&&controls.paused===false&&(!automatic||controls.owner_absent===true);
 if(rateFeedbackBlocksProvider(state,request?.provider,weekly_resource_id))return refusePace50('meter_coverage_required',state);
 if(state.mode==='off')return refusePace50('stopped',state);
 if(state.mode==='paused')return refusePace50('paused',state);
 if(state.owner_present&&!ownerPresenceOverride||!controlsOk)return refusePace50(state.owner_present?'owner_present':'controls',state);
 const badRequest=requestProblem(request,now);
 if(badRequest)return refusePace50(badRequest,state);
 if(state.attempts.some(a=>a.id===request.attempt_id))return refusePace50('duplicate_attempt',state);
 const evidenceProblem=policyEvidenceProblem(evidence,windows);
 if(evidenceProblem)return refusePace50(evidenceProblem,state);
 if(new Set(windows.map(w=>w?.id)).size!==windows.length||!windows.some(w=>w?.id===weekly_resource_id))
  return refusePace50('resource_identity',state);
 for(const w of windows){
  const problem=windowProblem(w,input,request);
  if(problem)return refusePace50(problem,state,problem==='reading_stale'?
   {effects:[{type:'request_fresh_complete_read'}]}:{});
  const watermark=aggregateWatermark(state,w);
  if(watermark&&(w.observed_at<watermark.observed_at||w.used_micro<watermark.used_micro))
   return refusePace50('aggregate_observation_regressed',state,
    {effects:[{type:'request_fresh_complete_read',resource_id:w.id}]});
  const conversionMismatch=state.attempts.some(attempt=>attempt.recoveries.some(recovery=>
   recovery.resources.some(resource=>sameResourceScope(resource,w)&&
    (resource.kind!==w.kind||resource.kappa_micro!==w.kappa_micro))));
  if(conversionMismatch)return refusePace50('cross_reset_conversion_mismatch',state);
 }
 if(windows.find(w=>w.id===weekly_resource_id)?.kind!=='weekly')
  return refusePace50('weekly_resource_mapping',state);
 // An unclosed or held attempt is already in the windows' totals, so it lowers the quote and does not refuse admission.
 // Exposure in a window instance that is no longer offered cannot be counted against the open windows, so it must settle first.
 const staleLedger=stateHasCrossWindowExposure(state,windows);
 if(staleLedger)return refusePace50('cross_window_exposure_unreconciled',state);
 // Native reservations and retained meter uncertainty enter the same headroom calculation.
 const native=windows.some(w=>w.conversion==='native_window');

 const objective = input.objective;
 if(!record(objective))return refusePace50('objective_evidence_unknown',state);
 const totalsById=new Map(windows.map(w=>{
  const totals=attemptResourceTotals(state,w.id,w.instance,w.epoch,w.anchor_at,w.resets_at);
  return [w.id,totals];
 }));
 const sourceRows=state.attempts.filter(attempt=>attempt.account_week_id===state.account_week_id)
  .flatMap(attempt=>attempt.resources).filter(resource=>['history','model'].includes(resource.protection_source));
 const priorSources=new Set(sourceRows.map(resource=>resource.protection_source));
 if(priorSources.size>1)return refusePace50('protection_source_inconsistent',state);
 const frozenProtectionSource=priorSources.values().next().value??objective.frozenProtectionSource??null;
 const objectiveWindows=Object.fromEntries(windows.map(w=>[w.id,{
  known:true,fresh:true,compatible:true,kind:w.kind,usedMicro:w.used_micro,
  committedMicro:state.attempts.flatMap(a=>a.resources).filter(r=>sameResourceScope(r,w)).reduce((sum,r)=>
    sum+repricedCommitmentMicro(r,native?null:w.kappa_micro),0),
  // Lent consumption includes observed overshoot, so a job that ran past its hold uses up the strategy share it consumed.
  lentMicro:Number(totalsById.get(w.id).spent+totalsById.get(w.id).held+totalsById.get(w.id).overshoot),
  ...(native?{conversion:'native_window'}:{}),
  pointsPerUsdMicro:native?null:w.kappa_micro,pointsPerUsdLowerMicro:w.kappa_lower_micro??null,resetAtMs:w.resets_at,
  uncertaintyMicro:(w.uncertainty_micro??0)+readingAgeReserve(w,now),anchorAtMs:w.anchor_at,durationMs:w.duration_ms,
  ownerUsedMicro:w.owner_used_micro??w.used_micro,
  instance:w.instance,epoch:w.epoch,
 }]));
 const suppliedModelData=record(objective.modelDataByResource)?objective.modelDataByResource:{};
 // The risk ledger counts the attempts issued before this decision. A new admission follows them all; a recheck of an
 // issued attempt follows only those before it, so a later issuance cannot leave a gap in its ordinals. Holds above
 // still count every attempt.
 const ledgerAttemptCount=input.ledger_attempt_count??state.attempts.length;
 if(!safeNat(ledgerAttemptCount)||ledgerAttemptCount>state.attempts.length)return refusePace50('invalid_input',state);
 const modelDataByResource=Object.fromEntries(windows.map(w=>{
  const priorRows=state.attempts.slice(0,ledgerAttemptCount).flatMap(attempt=>attempt.resources)
   .filter(resource=>sameResourceScope(resource,w)&&resource.demand_model);
  const first=priorRows[0]?.demand_model??null;
  const seed=record(suppliedModelData[w.id])?suppliedModelData[w.id]:{};
  const ownerUsed=w.owner_used_micro??w.used_micro;
  const initialOwnerUsed=first?.initial_owner_used_micro??seed.initialOwnerUsedMicro??0;
  const ownerCount=Math.floor(Math.max(0,ownerUsed-initialOwnerUsed)/Number(PACE50_POINT));
  const originAt=first?.origin_at_ms??seed.originAtMs??w.anchor_at;
  const exposureFraction=Math.max(0,Math.min(1,(now-originAt)/(w.resets_at-originAt)));
  const committed=totalsById.get(w.id).held+totalsById.get(w.id).unrepresented;
  const initialCapacity=first?.initial_capacity_points??Math.max(1,Math.ceil(
   (Number(PACE50_HUNDRED)-w.used_micro-(w.uncertainty_micro??0)-Number(committed))/Number(PACE50_POINT)));
  return [w.id,{priorState:first?.prior_state??seed.priorState??null,originAtMs:originAt,
   initialCapacityPoints:initialCapacity,initialOwnerUsedMicro:initialOwnerUsed,ownerCount,
   observations:{count:ownerCount},exposureFraction,updateIndex:priorRows.length+1,
   forecasts:priorRows.map(resource=>({ownerAtIssue:resource.demand_model.owner_count,
    reservePoints:resource.demand_model.reserve_points,
    updateIndex:resource.demand_model.update_index,riskAlpha:resource.demand_model.risk_alpha}))}];
 }));
 const observedAt=Math.min(...windows.map(w=>w.observed_at));
 const gates={consent:controls.consent===true,limits:controls.people===true&&controls.agents===true&&controls.schedule===true&&controls.unexpired===true,
  funding:evidence.subscription_only===true,stopping:state.mode==='on'&&controls.on===true&&controls.paused===false&&
   (objective.automatic===false||controls.owner_absent===true&&!state.owner_present)};
 let decision;
 try {
  decision=evaluateLending({policy:{protectionPosition:objective.position,strategy:objective.strategy,
    strategyParams:objective.strategyParams},objectiveInput:{
   ...objective,automatic:objective.automatic,now,observedAt,windows:objectiveWindows,weeklyResource:weekly_resource_id,gates,
   frozenProtectionSource,modelDataByResource,
   stopped:state.mode!=='on'||controls.on!==true||controls.paused===true||state.owner_present&&!ownerPresenceOverride,
   ...(objective.decide !== undefined ? {account} : {}),
   job:{...objective.job,
    ...(objective.decide !== undefined ? {provider:request.provider,model:request.model} : {}),
    wallMs:request.wall_ms,stopMs:request.stop_ms,uncertaintyMs:request.uncertainty_ms},
  }});
 }catch(error){return refusePace50(error?.message==='expected loss unresolved'?'demand_model_invalid':'objective_evidence_invalid',state);}
 // A hold that can clear through the sweep stays retryable; it never blocks a quote that fits.
 const pendingNative=native&&[...totalsById.values()].some(t=>t.held+t.unrepresented>0n);
 if(!decision.admitted)return refusePace50(pendingNative&&decision.reason==='owner_reserve'
  ?'native_attempt_in_flight':decision.reason,state,{objective:decision.objective,
  maximum_budget_micro:decision.exposureUsdMicro??0,native_budget_micro:decision.nativeBudgetUsdMicro??0});
 const reserve=decision.reservePointsMicro;
 if(!reserve||Object.keys(reserve).length!==windows.length||windows.some(w=>!Number.isSafeInteger(reserve[w.id])||reserve[w.id]<=0))
  return refusePace50('objective_reservation_invalid',state,{objective:decision.objective});
 const rows=[];
 for(const w of windows){
  const totals=attemptResourceTotals(state,w.id,w.instance,w.epoch,w.anchor_at,w.resets_at);
  const available=BigInt(PACE50_HUNDRED)-asMicro(w.used_micro)-asMicro(totals.held)-asMicro(totals.unrepresented);
  const amount=asMicro(reserve[w.id]);
  if(amount>available)return refusePace50('objective_reservation_exceeds_resource',state,{objective:decision.objective});
  rows.push({window:w,keep:0n,slack:available,cap:amount,maxBudget:amount,kappa:native?null:asMicro(w.kappa_micro),
   spent:totals.spent,held:totals.held,unrepresented:totals.unrepresented,exposure:amount});
 }
 const quotes=rows.map(r=>({id:r.window.id,instance:r.window.instance,epoch:r.window.epoch,kind:r.window.kind,
  keep_micro:0,slack_micro:Number(r.slack),cap_micro:Number(r.cap),spent_micro:Number(r.spent),held_micro:Number(r.held),
  exposure_micro:Number(r.exposure)}));
 const next=structuredClone(state);
 const attempt={id:request.attempt_id,account,account_week_id,epoch,job_id:request.job_id,created_at:now,
  ...(request.price_rev?{price_rev:request.price_rev}:{}),
  wall_ms:request.wall_ms,stop_ms:request.stop_ms,uncertainty_ms:request.uncertainty_ms,
  launch_state:'reserved',process_state:'not_started',cessation_proven:false,cleanup_proven:false,usage_unknown:null,
  served_model:observeServedModel({model:request.model,effort:request.effort}),
  late_ack_unresolved:false,late_ack_events:[],
  opening:null,
  recoveries:[],
  ...(ownerPresenceOverride?{owner_presence_override:true}:{}),
  resources:rows.map((r,index)=>{
   const model=decision.modelForecasts?.[r.window.id];
   const protection_source=decision.objective.protectionSource?.[r.window.id];
   return {id:r.window.id,instance:r.window.instance,epoch:r.window.epoch,
   kind:r.window.kind,anchor_at:r.window.anchor_at,resets_at:r.window.resets_at,
   duration_ms:r.window.duration_ms,baseline_used_micro:r.window.used_micro,
   ...(native?{conversion:'native_window',kappa_micro:null,
    meter_step_micro:safeNat(r.window.uncertainty_micro)&&r.window.uncertainty_micro>0
     ?r.window.uncertainty_micro:PROVIDER_PERCENT_UNCERTAINTY_MICRO,...(r.window.cold_open===true?{cold_open:true}:{})}:{kappa_micro:Number(r.kappa)}),
   aggregate_observed_at:r.window.observed_at,
   aggregate_used_micro:r.window.used_micro,initial_micro:Number(r.exposure),
   spent_micro:0,settled_micro:0,held_micro:Number(r.exposure),
   released_micro:0,unrepresented_micro:0,burns:[],protection_source,
   ...(model?{demand_model:{model_id:model.modelId,provenance:model.provenance,prior_state:model.priorState,
    origin_at_ms:model.originAtMs,initial_capacity_points:model.initialCapacityPoints,
    initial_owner_used_micro:model.initialOwnerUsedMicro,owner_count:model.ownerAtIssue,
    reserve_points:model.reservePoints,update_index:model.updateIndex,mark_bound:model.markBound,
    risk_alpha:model.riskAlpha}}:{})};
  })};
 next.attempts.push(attempt);
 next.revision++;next.updated_at=now;
 const effects=[{type:'persist_proposed_state_before_provider_action',
   expected_revision:state.revision,next_revision:next.revision,attempt_id:request.attempt_id}];
 const deadline=Number(attemptClosureDeadline(attempt,next));
 for(const w of windows)effects.push({type:'arm_cessation_deadline',attempt_id:request.attempt_id,
  resource_id:w.id,deadline_at:deadline,stop_bound_ms:request.stop_ms,uncertainty_ms:request.uncertainty_ms});
 // The native guard reads the meter while the job runs and stops it at its point allowance; it is armed before launch.
 if(native)effects.push({type:'arm_native_guard',attempt_id:request.attempt_id,
  allowance:attempt.resources.map(r=>({id:r.id,instance:r.instance,baseline_used_micro:r.baseline_used_micro,
   allowance_micro:r.initial_micro}))});
 effects.push({type:'launch_chunk',attempt_id:request.attempt_id});
 return {version:PACE50_VERSION,admitted:true,reason:'objective_lend',objective:decision.objective,
  ...(native?{conversion:'native_window'}:{}),
  budget_micro:decision.exposureUsdMicro,maximum_budget_micro:decision.exposureUsdMicro,
  native_budget_micro:decision.nativeBudgetUsdMicro,requested_fits:true,opening:null,windows:quotes,proposed_state:next,effects};
}
