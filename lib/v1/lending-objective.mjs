import {budgetLimitCopy} from './lending-status-copy.mjs';
// M1 objective-derived lending allocator. Pure: no clock, I/O, provider or sandbox calls.
// Port of the reviewed reference, research capacity-pooling/lending-default-comparison-2026-10-23/model.mjs
// at 788c609c (42 tests): the whole-week reserve band, the objective chooser and the repeated-decision layer.
// Not ported: optimalDivisibleReserve (one-shot analytic control), the six-arm simulator and its CLI.
// Departures, each recorded in NOTES.md:
//   1. Accounting is exact integer micro-units (1 point or 1 USD = 1,000,000 micro). Floats appear only in
//      the objective (friend value and expected owner loss), never in feasibility or budget arithmetic.
//   2. Eligibility is strict: every positive objective wins; exact ties hold. Tolerance ranks eligible actions only.
//   3. Band reserves round UP to the next micro-point; the band never under-protects.
//   4. Default protection is Keep more for me (epsilon 0.10), per the measured-rate replay decision.
//   5. Binding design (2026-10-23): the dial is epsilon, the harm-probability cap. The decision maximizes expected
//      useful value subject to P(harm) <= epsilon; the reference's lambda penalty (value minus lambda times loss)
//      is not used. lambda = 1/epsilon survives only as a display field.

import {evaluateLendingRule, lendingRuleErrorCode} from './lending-rule-seam.mjs';
import {chunkLimitUsdMicro} from './chunk-limit.mjs';
import {DEFAULT_LENDING_STRATEGY, DEFAULT_STRATEGY_CONFIG, lendableByStrategy, normalizeStrategyConfig, strategyConfigReady, strategyExplanation} from './lending-strategy.mjs';
import {finiteQuantile} from './lending-dayone.mjs';
import {demandModelKind, demandModelProblem, evaluateDemandModel} from './lending-demand-model.mjs';
import {CONTINUOUS_DEMAND_MODEL, continuousWindowProtection} from './lending-continuous-model.mjs';
import {chooseResetIndexedSchedule, rational} from './lending-schedule.mjs';

export const MICRO = 1_000_000;
export const WINDOW_CAP_MICRO = 100 * MICRO;
export const POLICY_VERSION = 'objective/m1';
// The one dial is epsilon, the harm-probability cap (binding design, 2026-10-23). `lambda` = 1/epsilon is an
// interpretation for display only: no decision uses it. epsilonFraction is the exact value of epsilon.
export const PROTECTION_POSITIONS = Object.freeze({
  keep_more_for_me: Object.freeze({label: 'Keep more for me', lambda: 10, epsilon: .10, epsilonFraction: Object.freeze([1, 10])}),
  balanced: Object.freeze({label: 'Balanced', lambda: 4, epsilon: .25, epsilonFraction: Object.freeze([1, 4])}),
  share_more: Object.freeze({label: 'Share more', lambda: 2, epsilon: .50, epsilonFraction: Object.freeze([1, 2])}),
});
export const DEFAULT_PROTECTION = 'keep_more_for_me';

const MAX_BAND_WEEKS = 26;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const TIE = 1e-9;
const tolerance = (a, b) => TIE * Math.max(1, Math.abs(a), Math.abs(b));
const isMicro = (x, max = MAX_SAFE) => Number.isSafeInteger(x) && x >= 0 && x <= max;

function num(x, name, max = MAX_SAFE) {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > max) throw new RangeError('invalid ' + name);
  return x;
}
function micro(x, name, max = MAX_SAFE) {
  if (!isMicro(x, max)) throw new RangeError('invalid ' + name);
  return x;
}
function list(xs, name, max) {
  if (!Array.isArray(xs) || xs.length === 0 || xs.length > max) throw new RangeError('invalid ' + name);
  return xs;
}
function lambdaOf(position) {
  if (!Object.hasOwn(PROTECTION_POSITIONS, position)) throw new TypeError('unknown protection position');
  return PROTECTION_POSITIONS[position].lambda;
}
function epsilonOf(position) {
  if (!Object.hasOwn(PROTECTION_POSITIONS, position)) throw new TypeError('unknown protection position');
  return PROTECTION_POSITIONS[position].epsilon;
}
const HOUR_MS = 60 * 60 * 1000;
function probabilities(items) {
  const sum = items.reduce((s, x) => s + num(x.probability, 'probability', 1), 0);
  if (Math.abs(sum - 1) > 1e-12) throw new RangeError('probabilities must sum to one');
  return items.map(x => ({...x, probability: x.probability / sum}));
}

// usd = points / (points per usd). Reservations round UP so they cover their exposure; budgets round DOWN.
export function pointsForUsdMicro(usdMicro, pointsPerUsdMicro) {
  micro(usdMicro, 'usdMicro');
  if (micro(pointsPerUsdMicro, 'pointsPerUsdMicro') === 0) throw new RangeError('conversion must be positive');
  const value = (BigInt(usdMicro) * BigInt(pointsPerUsdMicro) + BigInt(MICRO - 1)) / BigInt(MICRO);
  if (value > BigInt(MAX_SAFE)) throw new RangeError('points conversion exceeds safe integer range');
  return Number(value);
}
export function usdForPointsMicro(pointsMicro, pointsPerUsdMicro) {
  micro(pointsMicro, 'pointsMicro');
  if (micro(pointsPerUsdMicro, 'pointsPerUsdMicro') === 0) throw new RangeError('conversion must be positive');
  const value = BigInt(pointsMicro) * BigInt(MICRO) / BigInt(pointsPerUsdMicro);
  if (value > BigInt(MAX_SAFE)) throw new RangeError('USD conversion exceeds safe integer range');
  return Number(value);
}

function exactRecord(value, ids, name) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
    Object.keys(value).length === ids.length && ids.every(id => Object.hasOwn(value, id))
    ? value : (() => { throw new TypeError(name + ' must bind every exact resource identity'); })();
}

/**
 * Native --max-budget-usd for a gross cost vector. The owner cap and every resource's spare bound total spend;
 * one worst-case final call is subtracted after taking their minimum.
 * Non-positive results are budgets too small for one worst-case call.
 */
export function quotaBudgetUsdMicro(costMicro, pointsPerUsdMicro, strategyCeilingUsdMicro = null, worstCallUsdMicro) {
  const ids = Object.keys(costMicro ?? {});
  if (ids.length === 0) throw new TypeError('conversion must cover exact resources');
  exactRecord(costMicro, ids, 'cost');
  exactRecord(pointsPerUsdMicro, ids, 'conversion');
  const worst = micro(worstCallUsdMicro, 'worstCallUsd');
  let gross = strategyCeilingUsdMicro === null ? Infinity : micro(strategyCeilingUsdMicro, 'strategyCeilingUsd');
  for (const id of ids) {
    if (!Object.hasOwn(pointsPerUsdMicro, id)) throw new TypeError('conversion identity mismatch');
    gross = Math.min(gross, usdForPointsMicro(micro(costMicro[id], 'cost'), pointsPerUsdMicro[id]));
  }
  if (!Number.isFinite(gross)) throw new TypeError('empty conversion');
  return gross - worst;
}

// Owner attempts in order against remaining capacity. A divisible attempt takes the available fraction; an
// atomic attempt takes nothing unless whole. Served value is fraction x value.
function serve(attempts, cost, capacity) {
  const left = capacity.map((n, i) => n - cost[i]);
  return attempts.map(a => {
    let fraction = 1;
    a.need.forEach((n, i) => { if (n > 0) fraction = Math.min(fraction, left[i] / n); });
    fraction = Math.max(0, Math.min(1, fraction));
    if (a.atomic && fraction < 1) fraction = 0;
    a.need.forEach((n, i) => { left[i] = Math.max(0, left[i] - fraction * n); });
    return fraction * a.value;
  });
}
// Expected gross displaced owner service caused by taking `cost` before the owner's attempts.
function lossesByScenario(scenarios, cost, capacity) {
  const zero = cost.map(() => 0);
  return scenarios.map(s => {
    const base = serve(s.attempts, zero, capacity), served = serve(s.attempts, cost, capacity);
    return {id: s.id, probability: s.probability,
      loss: base.reduce((loss, n, j) => loss + Math.max(0, n - served[j]), 0)};
  });
}
function lossOf(scenarios, cost, capacity) {
  const byScenario = lossesByScenario(scenarios, cost, capacity);
  return {expected: byScenario.reduce((sum, s) => sum + s.probability * s.loss, 0), byScenario};
}

// Eligibility is strict: an action must beat "none" (objective 0) by more than the tolerance. Zero value and
// zero harm, and exact equality, choose none whatever the action id. Among eligible actions the tie set is
// anchored to the maximum, so action order cannot change the answer; then lower owner loss, then lower id.
function chooseBest(evaluations, compareLoss = null) {
  const none = evaluations.find(a => a.id === 'none');
  const winners = evaluations.filter(a => a.id !== 'none' && a.feasible && a.objective > none.objective);
  if (winners.length === 0) return 'none';
  const maximum = Math.max(...winners.map(a => a.objective));
  const tied = winners.filter(a => maximum - a.objective <= tolerance(maximum, a.objective));
  return tied.reduce((best, action) => {
    if (!best) return action;
    const compared = compareLoss ? compareLoss(action, best)
      : action.loss < best.loss ? -1 : action.loss > best.loss ? 1 : 0;
    return compared < 0 || compared === 0 && action.id < best.id ? action : best;
  }, null).id;
}

/**
 * One action against a fixed scenario set, with exact resource identities. The objective is expected useful value;
 * the owner's protection is the chance constraint that the caller's slack already enforces, so owner loss is reported
 * and breaks ties but is never subtracted from value. `lossOfCost(costPointsById)`, when given, replaces the scenario
 * simulation with the continuous model's closed-form harm.
 */
export function chooseObjectiveAction({resources, actions, scenarios, gates, lossOfCost = null}) {
  const rs = list(resources, 'resources', 8).map(r => {
    if (typeof r.id !== 'string' || !r.id || r.id === '__proto__' || r.known !== true || r.fresh !== true || r.compatible !== true)
      throw new TypeError('unknown or incompatible resource');
    return {id: r.id, remaining: num(r.remaining, 'remaining')};
  });
  const ids = rs.map(r => r.id);
  if (new Set(ids).size !== ids.length) throw new TypeError('duplicate resource');
  const vector = v => {
    exactRecord(v, ids, 'resource vector');
    return ids.map(id => num(v[id], 'resource amount'));
  };
  if (!Array.isArray(actions) || actions.length > 64) throw new RangeError('invalid actions');
  const seen = new Set(['none']);
  const candidates = actions.map(a => {
    if (typeof a.id !== 'string' || !a.id || a.id === '__proto__' || seen.has(a.id)) throw new TypeError('duplicate or invalid action');
    seen.add(a.id);
    return {id: a.id, cost: vector(a.cost), usefulValue: num(a.usefulValue, 'usefulValue'), permitted: a.permitted === true};
  });
  const scenarioIds = new Set();
  const ss = lossOfCost ? null : probabilities(list(scenarios, 'scenarios', 128).map((s, i) => {
    const id = s.id ?? `scenario-${i}`;
    if (typeof id !== 'string' || !id || id === '__proto__' || scenarioIds.has(id)) throw new TypeError('invalid scenario identity');
    scenarioIds.add(id);
    if (!Array.isArray(s.attempts) || s.attempts.length > 128) throw new RangeError('invalid attempts');
    return {probability: s.probability, attempts: s.attempts.map(a => {
      if (typeof a.atomic !== 'boolean') throw new TypeError('atomic must be explicit');
      return {need: vector(a.need), value: num(a.value, 'owner service value'), atomic: a.atomic};
    }), id};
  }));
  const capacity = rs.map(r => r.remaining);
  const costsById = new Map(candidates.map(action => [action.id, action.cost]));
  const gatesPass = ['consent', 'limits', 'funding', 'stopping'].every(k => gates && Object.hasOwn(gates, k) && gates[k] === true);
  const zero = ids.map(() => 0);
  const evaluations = [{id: 'none', cost: zero, usefulValue: 0, permitted: true}, ...candidates].map(a => {
    const reasons = [];
    if (a.id !== 'none' && !gatesPass) reasons.push('hard_gate_not_proven');
    if (!a.permitted) reasons.push('action_not_permitted');
    a.cost.forEach((n, i) => { if (n > capacity[i]) reasons.push('resource_fit:' + ids[i]); });
    if (reasons.length) return {id: a.id, feasible: false, reasons, usefulValue: a.usefulValue, loss: null, objective: null};
    const {expected: loss, byScenario} = lossOfCost
      ? {expected: lossOfCost(Object.fromEntries(ids.map((id, i) => [id, a.cost[i]]))), byScenario: null}
      : lossOf(ss, a.cost, capacity);
    return {id: a.id, feasible: true, reasons: [], usefulValue: a.usefulValue, loss, scenarioLoss: byScenario,
      objective: a.usefulValue};
  });
  const compareLoss = typeof lossOfCost?.compare === 'function'
    ? (left, right) => lossOfCost.compare(Object.fromEntries(ids.map((id, i) => [id, costsById.get(left.id)[i]])),
      Object.fromEntries(ids.map((id, i) => [id, costsById.get(right.id)[i]])))
    : null;
  return {choice: chooseBest(evaluations, compareLoss), evaluations,
    lossUnits: 'weighted gross displaced owner service; no cross-request compensation',
    delay: 'not modeled', optimality: 'supplied feasible actions and declared scenarios only'};
}

/**
 * Whole-week band: one residual per completed week, taken as the maximum over the ENTIRE frozen domain.
 * The threshold is the k-th smallest of the latest (<= 26) weeks, k = ceil((n+1)(1 - epsilon)). Missing or
 * censored required labels count as +Infinity; history shorter than k leaves the threshold at +Infinity.
 */
export function wholeWeekReserveBand({position = DEFAULT_PROTECTION, weekStart, epoch, procedure, domain, weeks, forecasts}) {
  const lambda = lambdaOf(position);
  const epsilon = epsilonOf(position);
  num(weekStart, 'weekStart');
  if (typeof epoch !== 'string' || !epoch || typeof procedure !== 'string' || !procedure) throw new TypeError('missing frozen scoring identity');
  list(domain, 'full score domain', 4096);
  if (domain.some(d => typeof d !== 'string' || !d) || new Set(domain).size !== domain.length) throw new TypeError('invalid score domain');
  if (!Array.isArray(weeks) || weeks.length > 1024) throw new TypeError('invalid weeks');
  const seen = new Set();
  const ordered = weeks.map(w => {
    if (!w || typeof w.id !== 'string' || !w.id || seen.has(w.id) || !Number.isFinite(w.end) ||
        w.end > weekStart || w.epoch !== epoch || w.procedure !== procedure)
      throw new TypeError('duplicate, future or incompatible week');
    seen.add(w.id);
    let score = w.complete === true ? -Infinity : Infinity;
    for (const d of domain) {
      const x = w.upperScores && Object.hasOwn(w.upperScores, d) ? w.upperScores[d] : undefined;
      score = Math.max(score, typeof x === 'number' && !Number.isNaN(x) ? x : Infinity);
    }
    return {end: w.end, score};
  }).sort((a, b) => a.end - b.end);
  if (ordered.some((w, i) => i && w.end === ordered[i - 1].end)) throw new TypeError('duplicate week end');
  const selected = ordered.slice(-MAX_BAND_WEEKS), n = selected.length;
  const rank = Math.ceil((n + 1) * (1 - epsilon));
  const threshold = rank > n ? Infinity :
    selected.map(w => w.score).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[rank - 1];
  const reserves = {};
  for (const f of list(forecasts, 'forecasts', 8)) {
    if (typeof f.id !== 'string' || !f.id || f.id === '__proto__' || Object.hasOwn(reserves, f.id) || !domain.includes(f.domain))
      throw new TypeError('invalid forecast identity or domain');
    const prediction = num(f.prediction, 'prediction');
    const scale = num(f.scale, 'scale');
    if (scale === 0) throw new RangeError('scale must be positive');
    reserves[f.id] = threshold === Infinity ? Infinity : threshold === -Infinity ? 0 : Math.max(0, prediction + threshold * scale);
    if (Number.isNaN(reserves[f.id])) throw new RangeError('invalid band reserve');
  }
  return {lambda, epsilon, n, rank, threshold, reserves,
    status: rank > n ? 'insufficient_history' : Object.values(reserves).some(q => q === Infinity) ? 'unbounded' : 'finite',
    guarantee: 'conditional marginal whole-week bound only; external premises required'};
}

function reserveToMicro(q) {
  if (q === Infinity) return Infinity;
  const value = Math.max(0, Math.ceil(q * MICRO));
  if (!Number.isSafeInteger(value)) throw new RangeError('reserve exceeds safe integer range');
  return value;
}
function bandReserves({band, position, ids}) {
  const calibrated = wholeWeekReserveBand({...band, position});
  exactRecord(calibrated.reserves, ids, 'band reserve');
  return {calibrated, guarantee: calibrated.guarantee,
    protectionSource: calibrated.rank <= calibrated.n ? 'history' : 'pace',
    reservesMicro: Object.fromEntries(ids.map(id => [id, reserveToMicro(calibrated.reserves[id])]))};
}

function modelReserves({ids, windows, remaining, position, demandModel, modelDataByResource = {}, now}) {
  const problem = demandModelProblem(demandModel);
  if (problem) return {problem:'demand_model_unavailable'};
  if (demandModel.supportedResourceCount !== undefined && demandModel.supportedResourceCount !== ids.length)
    return {problem:'demand_model_coupling_unknown'};
  const epsilon = epsilonOf(position), reservesMicro = {}, forecasts = {}, scenarios = [];
  try {
    for (const id of ids) {
      const window = windows[id], modelData = modelDataByResource[id] ?? {};
      const capacityPoints = modelData.initialCapacityPoints ?? Math.ceil(remaining[id] / MICRO);
      const observations = modelData.observations ?? {count:0};
      const exposureFraction = modelData.exposureFraction ?? 0;
      const updateIndex = modelData.updateIndex ?? 1;
      const evaluated = evaluateDemandModel(demandModel, {resourceId:id, capacityPoints, observations,
        exposureFraction, updateIndex, priorState:modelData.priorState ?? null, resources:ids.map(resourceId => ({
          id:resourceId,capacityPoints:modelDataByResource[resourceId]?.initialCapacityPoints ?? Math.ceil(remaining[resourceId] / MICRO),
        })), epsilon});
      const demandAmount = atom => {
        if (ids.length === 1 && Number.isFinite(atom.amount)) return atom.amount;
        const value = atom.demandByResource?.[id];
        return Number.isFinite(value) ? value : (() => { throw new TypeError('joint posterior resource coordinate missing'); })();
      };
      const atoms = evaluated.posterior.map(atom => ({amount:demandAmount(atom) * evaluated.markBound, probability:atom.probability}));
      const newReserve = finiteQuantile(atoms, evaluated.riskAlpha);
      const ownerAtIssue = modelData.ownerCount ?? 0;
      let latestForecast = null;
      for (const row of modelData.forecasts ?? []) {
        if (!Number.isFinite(row.ownerAtIssue) || !Number.isFinite(row.reservePoints)) throw new TypeError('invalid persisted model forecast');
        if (row.updateIndex !== undefined && (!Number.isSafeInteger(row.updateIndex) || row.updateIndex < 1))
          throw new TypeError('invalid persisted model forecast');
        if (!latestForecast || row.updateIndex === undefined || latestForecast.updateIndex === undefined ||
            row.updateIndex >= latestForecast.updateIndex) latestForecast = row;
      }
      const carried = latestForecast
        ? Math.min(newReserve, Math.max(0, latestForecast.reservePoints - (ownerAtIssue - latestForecast.ownerAtIssue)))
        : newReserve;
      reservesMicro[id] = Math.min(remaining[id], Math.ceil(carried * MICRO));
      forecasts[id] = {modelId:evaluated.modelId,priorState:evaluated.prior,updateIndex,
        ownerAtIssue,reservePoints:newReserve,markBound:evaluated.markBound,riskAlpha:evaluated.riskAlpha,
        provenance:evaluated.provenance,originAtMs:modelData.originAtMs??now,
        initialCapacityPoints:capacityPoints,
        initialOwnerUsedMicro:modelData.initialOwnerUsedMicro??window.ownerUsedMicro??window.usedMicro};
      if (ids.length === 1) scenarios.push(...evaluated.ownerScenarios);
    }
  } catch (error) {
    return {problem:error?.message?.includes('coupled-window') || error?.message?.includes('resource coordinate')
      ?'demand_model_coupling_unknown':'demand_model_invalid'};
  }
  return {reservesMicro,forecasts,ownerScenarios:scenarios,predictiveFeasible:true,lossOfCost:null,
    modelId:demandModel.id,modelLabel:`${demandModel.label} Provenance: ${demandModel.provenance}`,provenance:demandModel.provenance};
}

// The seam's two shapes answer one question: lendable and reserve micro-points per window, and the expected owner
// loss of a cost. The continuous shape also reports whether its declared risk budget is feasible.
function protectByModel({demandModel, ids, windows, remaining, position, now, modelDataByResource}) {
  if (demandModelKind(demandModel) === 'continuous-gamma') {
    const protection = continuousWindowProtection({model: demandModel, epsilon: epsilonOf(position), nowMs: now, weeklyId: ids[0],
      quotaPoints: WINDOW_CAP_MICRO / MICRO,
      windows: Object.fromEntries(ids.map(id => [id, {kind: windows[id].kind, remainingMicro: remaining[id],
        resetAtMs: windows[id].resetAtMs, ownerUsedMicro: windows[id].ownerUsedMicro ?? windows[id].usedMicro,
        uncertaintyMicro: windows[id].uncertaintyMicro ?? 0, pointsPerUsdMicro: windows[id].pointsPerUsdMicro}])), modelDataByResource});
    if (protection.problem) return protection;
    return {...protection, ownerScenarios: null, lossOfCost: protection.expectedLoss};
  }
  return modelReserves({ids, windows, remaining, position, demandModel, modelDataByResource, now});
}

const MODEL_PROBLEM_TEXT = Object.freeze({
  demand_model_unavailable: 'Holding because the supplied demand model is not a recognized model.',
  demand_model_invalid: 'Holding because the demand model could not evaluate this window from its recorded state.',
  demand_model_coupling_unknown: 'Holding because this demand model does not specify the coupled quota windows.',
  demand_model_exact_usage_required:
    'Holding because the demand model needs exact owner usage since its origin, and this window has none recorded.',
});

function sourceMap(ids, source) {
  return Object.fromEntries(ids.map(id => [id, source]));
}

/**
 * Repeated-decision layer for one action, against the joint whole-week band, the deferral envelope and every
 * exact resource's protected spare. Feasibility is exact integer arithmetic. Action usdMicro is the native
 * budget the job will launch with; the gross cost vector includes the overshoot once.
 */
export function chooseLendingAction({resources, actions, scenarios, gates, band, position = DEFAULT_PROTECTION,
  weeklyResource, now, stopMarginMs, laterBurnCapacityMicro, strategyCeilingUsdMicro = null,
  protectedReservesMicro = null, protectionSource = null, lossOfCost = null}) {
  num(now, 'now'); num(stopMarginMs, 'stopMarginMs');
  if (laterBurnCapacityMicro === undefined) throw new TypeError('queue assessment required');
  micro(laterBurnCapacityMicro, 'laterBurnCapacityMicro');
  if (strategyCeilingUsdMicro !== null) micro(strategyCeilingUsdMicro, 'strategyCeilingUsd');
  const rs = list(resources, 'resources', 8);
  const ids = rs.map(r => r.id);
  if (new Set(ids).size !== ids.length || !ids.includes(weeklyResource)) throw new TypeError('missing or duplicate resource');
  for (const r of rs) {
    if (typeof r.id !== 'string' || !r.id || r.id === '__proto__' || r.known !== true || r.fresh !== true || r.compatible !== true)
      throw new TypeError('unknown or incompatible resource');
    micro(r.remainingMicro, 'remainingMicro');
    if (micro(r.pointsPerUsdMicro, 'pointsPerUsdMicro') === 0) throw new RangeError('conversion must be positive');
    num(r.resetAtMs, 'resetAtMs');
    if (r.resetAtMs <= now) throw new RangeError('expired resource');
  }
  const kOf = Object.fromEntries(rs.map(r => [r.id, r.pointsPerUsdMicro]));
  const calibrated = wholeWeekReserveBand({...band, position});
  const guarantee = calibrated.guarantee;
  const reservesMicro = protectedReservesMicro ?? bandReserves({band, position, ids}).reservesMicro;
  exactRecord(reservesMicro, ids, 'protected reserve');
  const unresolved = ids.some(id => reservesMicro[id] === Infinity);
  const slack = Object.fromEntries(rs.map(r => [r.id, Math.max(0, r.remainingMicro - reservesMicro[r.id])]));
  // Continuous later capacity is not a per-job maximum. Complete discrete schedules
  // are compared as a finite list when the queue supplies them.
  const lendNowMicro = slack[weeklyResource];
  const horizon = Math.min(...rs.map(r => r.resetAtMs));
  if (!Array.isArray(actions) || actions.length > 64) throw new TypeError('invalid actions');
  const reasonsById = {}, nativeBudgetsMicro = {};
  const bounded = actions.map(a => {
    if (typeof a.id !== 'string' || !a.id || a.id === 'none' || a.id === '__proto__') throw new TypeError('invalid action id');
    const costVector = exactRecord(a.costMicro, ids, 'cost');
    const costMicro = Object.fromEntries(ids.map(id => [id, micro(costVector[id], 'costMicro')]));
    const reasons = [];
    if (!Number.isFinite(a.finishMs) || a.finishMs < now || a.finishMs + stopMarginMs >= horizon) reasons.push('finish_before_every_reset');
    const budget = quotaBudgetUsdMicro(costMicro, kOf, strategyCeilingUsdMicro, a.worstCallUsdMicro);
    nativeBudgetsMicro[a.id] = budget;
    if (budget <= 0) reasons.push('budget_too_small');
    if (micro(a.usdMicro, 'usdMicro') > budget) reasons.push('native_call_usd_cap');
    for (const id of ids) if (costMicro[id] > slack[id]) reasons.push('protected_reserve:' + id);
    if (unresolved) reasons.push('protected_reserve_unbounded');
    reasonsById[a.id] = reasons;
    return {id: a.id, cost: Object.fromEntries(ids.map(id => [id, costMicro[id] / MICRO])),
      usefulValue: num(a.usefulValue, 'usefulValue'), permitted: a.permitted === true && reasons.length === 0};
  });
  const result = chooseObjectiveAction({
    resources: rs.map(r => ({id: r.id, remaining: r.remainingMicro / MICRO, known: true, fresh: true, compatible: true})),
    actions: bounded, scenarios, gates, lossOfCost,
  });
  return {...result,
    evaluations: result.evaluations.map(a => ({...a, reasons: [...a.reasons, ...(reasonsById[a.id] ?? [])]})),
    band: calibrated, guarantee, reservesMicro, slackMicro: slack, lendNowMicro, horizonMs: horizon,
    nativeBudgetsMicro, unresolved, protectionSource,
    optimality: 'tolerance-ranked supplied actions within resource bands; deferral is a schedule comparison, not a job-size cap'};
}

// Explanation copy. Points and USD are exact decimal strings from integer micro-units.
function amount(value, minDecimals) {
  const frac = String(value % MICRO).padStart(6, '0').replace(/0+$/, '');
  const whole = String(Math.floor(value / MICRO));
  if (frac) return `${whole}.${frac}`;
  return minDecimals ? `${whole}.${'0'.repeat(minDecimals)}` : whole;
}
const pointsText = micro => amount(micro, 0);
const usdText = micro => '$' + amount(micro, 2);
const iso = ms => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const pointsMap = (ids, pick) => Object.fromEntries(ids.map(id => [id, pick(id) / MICRO]));

/** The explanation every read surface must return unchanged. Field order is the M1 contract. */
export function objectiveProjection(d) {
  return {
    schemaVersion: 1, policyVersion: POLICY_VERSION, admission: d.admitted ? 'allowed' : 'held',
    reasonCode: d.reasonCode, strategyId: d.strategyId, strategyExplanation: d.strategyExplanation,
    dial: d.dial, lambda: d.lambda, epsilon: d.epsilon,
    protectionSource: d.protectionSource, demandModelId:d.demandModelId, demandModelLabel:d.demandModelLabel,
    bindingWindow: d.bindingWindow,
    observedAt: d.observedAt, resetsAt: d.resetsAt, usedPoints: d.usedPoints, committedPoints: d.committedPoints,
    protectedOwnerPoints: d.protectedOwnerPoints, lendablePoints: d.lendablePoints, estimateUsd: d.estimateUsd,
    maximumExposureUsd: d.maximumExposureUsd, nativeMaxBudgetUsd: d.nativeMaxBudgetUsd,
    requestedUsd: d.requestedUsd ?? null, friendValue: d.friendValue,
    expectedOwnerHarm: d.expectedOwnerHarm, reasonText: d.reasonText,
    ...(d.budgetLimit ? {budgetLimit:d.budgetLimit} : {}),
    ...(d.ruleReasonCode ? {ruleReasonCode:d.ruleReasonCode} : {}),
    // A native-window decision says so, so the status line names points mode (lendingStatus reads `conversion`).
    ...(d.conversion ? {conversion:d.conversion} : {}),
  };
}

/**
 * One borrower job against one account's live windows. Keys of `windows` are exact resource ids; the weekly
 * one is named by weeklyResource. Malformed evidence throws; callers turn a throw into a hold, never a launch.
 * Gross exposure = min(spare-derived, requested, owner cap). Native = gross - worst-call headroom.
 */
export function decideObjectiveLend(input) {
  const {now, observedAt, position = DEFAULT_PROTECTION, weeklyResource = 'seven_day', windows = {}, band,
    owner, stopped = false, gates, laterBurnCapacityMicro, strategy = DEFAULT_LENDING_STRATEGY,
    strategyConfig = DEFAULT_STRATEGY_CONFIG,
    strategyCeilingUsdMicro = null, job, demandModel = null, modelDataByResource = {}, frozenProtectionSource = null,
    resetIndexedSchedule = null, strategyCeilingPointsMicro = null} = input ?? {};
  const lambda = lambdaOf(position);
  const normalizedStrategyConfig = normalizeStrategyConfig(strategyConfig);
  const strategyText = strategyExplanation(strategy, normalizedStrategyConfig);
  const automatic = strategy === 'automatic';
  const needsLentAccounting = strategy === 'fixed_share' || strategy === 'custom';
  num(now, 'now');
  if (laterBurnCapacityMicro === undefined) throw new TypeError('queue assessment required');
  micro(laterBurnCapacityMicro, 'laterBurnCapacityMicro');
  if (strategyCeilingUsdMicro !== null) micro(strategyCeilingUsdMicro, 'strategyCeilingUsd');
  if (!job) throw new TypeError('job is required');
  const wallMs = num(job.wallMs, 'wallMs');
  const uncertaintyMs = num(job.uncertaintyMs, 'uncertaintyMs');
  const stopMs = num(job.stopMs, 'stopMs');
  const estimateUsdMicro = micro(job.estimateUsdMicro, 'estimateUsdMicro');
  const worstCallUsdMicro = micro(job.worstCallUsdMicro, 'worstCallUsd');
  const requestedUsdMicro = job.requestedUsdMicro ?? null;
  if (requestedUsdMicro !== null) micro(requestedUsdMicro, 'requestedUsdMicro');
  if (!Object.hasOwn(windows, weeklyResource)) throw new TypeError('windows must include the weekly resource');
  if (windows[weeklyResource]?.kind !== 'weekly')
    throw new TypeError('weekly resource must declare weekly kind');
  // Weekly first: ties in the binding window resolve to the weekly window.
  const ids = [weeklyResource, ...Object.keys(windows).filter(id => id !== weeklyResource)];
  // Native-window mode: no window has a measured conversion, so the budget stays in window points and the live meter guards
  // the job. It is all or none, as one attempt's windows share one settlement.
  const nativeWindows = ids.some(id => windows[id]?.conversion === 'native_window');
  if (nativeWindows && !ids.every(id => windows[id]?.conversion === 'native_window' && windows[id].pointsPerUsdMicro === null))
    throw new TypeError('native-window mode must cover every window');
  if (strategyCeilingPointsMicro !== null) micro(strategyCeilingPointsMicro, 'strategyCeilingPointsMicro');

  // Evidence on every decision. Unknown evidence is shown as null, never as a default.
  const readable = ids.every(id => {
    const w = windows[id];
    return w && w.known === true && w.fresh === true && w.compatible === true && isMicro(w.usedMicro) &&
      isMicro(w.committedMicro) && isMicro(w.uncertaintyMicro ?? 0) &&
      (nativeWindows || isMicro(w.pointsPerUsdMicro) && w.pointsPerUsdMicro > 0) && Number.isFinite(w.resetAtMs) && (!needsLentAccounting || isMicro(w.lentMicro));
  });
  const fresh = Number.isFinite(observedAt) && now - observedAt >= 0;
  const defaultFriendValue = job.friendValue ?? job.chunkCandidates?.[0]?.friendValue;
  // An injected rule decides without a friend value; the app's send paths supply none, so it is shown as unknown.
  const friendValue = automatic && !(input.decide !== undefined && defaultFriendValue === undefined)
    ? num(defaultFriendValue, 'friendValue') : null;
  const shownBase = {
    strategyId:strategy, strategyExplanation:strategyText,
    dial: position, lambda, epsilon: epsilonOf(position), friendValue, estimateUsd: estimateUsdMicro / MICRO,
    requestedUsd: requestedUsdMicro === null ? null : requestedUsdMicro / MICRO,
    observedAt: iso(observedAt),
    resetsAt: readable ? Object.fromEntries(ids.map(id => [id, iso(windows[id].resetAtMs)])) : null,
    usedPoints: readable ? pointsMap(ids, id => windows[id].usedMicro) : null,
    committedPoints: readable ? pointsMap(ids, id => windows[id].committedMicro) : null,
    protectionSource: automatic ? null : sourceMap(ids, 'strategy'), demandModelId:null, demandModelLabel:null, bindingWindow: null,
    protectedOwnerPoints: null, lendablePoints: null,
    maximumExposureUsd: 0, nativeMaxBudgetUsd: 0, expectedOwnerHarm: null,
  };
  const hold = (reason, reasonCode, reasonText, fields = {}) => {
    const minimumUsd = job.minimumCallUsd;
    const ownerUsd = strategyCeilingUsdMicro === null ? null : strategyCeilingUsdMicro / MICRO;
    const requestedUsd = requestedUsdMicro === null ? null : requestedUsdMicro / MICRO;
    // Name a strategy ceiling below one call before considering the requested size.
    const ownerShort = ownerUsd !== null && ownerUsd < minimumUsd;
    const borrowerShort = !job.statusProjection && requestedUsd !== null && requestedUsd < minimumUsd;
    const budgetLimit = reason === 'budget_too_small' && Number.isFinite(minimumUsd) ? {
      model:job.model, minimumUsd,
      source: ownerShort ? 'strategy' : borrowerShort ? 'borrower' : 'spare',
      limitUsd: ownerShort ? ownerUsd : borrowerShort ? requestedUsd : ownerUsd,
    } : null;
    const d = {...shownBase, ...fields, admitted: false, reasonCode,
      reasonText:budgetLimit ? budgetLimitCopy(budgetLimit).line : reasonText,
      ...(budgetLimit ? {budgetLimit} : {})};
    return {...d, reason, projection: objectiveProjection(d)};
  };

  // Native-window admission. The point allowance comes from the same rule and strategy controls as a calibrated job: the
  // slack each window keeps after the owner reserve, capped by the strategy's point ceiling on the weekly window. Only the
  // A native window cannot convert a job size into points. Its strategy ceiling and the
  // request bound the native budget, and the live meter guard, not a converted burn, holds the job to its points.
  const nativeLend = ({reserve, fields, ruleReasonCode, modelForecasts = null}) => {
    const reservePointsMicro = Object.fromEntries(ids.map(id => [id, id === weeklyResource && strategyCeilingPointsMicro !== null
      ? Math.min(reserve[id], strategyCeilingPointsMicro) : reserve[id]]));
    const nativeFields = {...fields, lendablePoints:pointsMap(ids, id => reservePointsMicro[id])};
    if (strategyCeilingPointsMicro !== null && reservePointsMicro[weeklyResource] <= 0)
      return hold('strategy_limit', 'objective_strategy_limit',
        'Holding this job: the limit you set for this lending strategy leaves no weekly points now.', nativeFields);
    const empty = ids.find(id => !(reservePointsMicro[id] > 0));
    if (empty !== undefined)
      return hold('owner_reserve', 'objective_owner_reserve',
        `Holding this job: no ${windows[empty].kind} points are spare after protecting your use.`,
        {...nativeFields, bindingWindow:empty});
    // The account facade quotes points without inventing a dollar conversion or cap.
    if (input.pointsOnly === true) return {...nativeFields, admitted:true, reason:'lend',
      reservePointsMicro, nativeBudgetUsdMicro:0, conversion:'native_window'};
    const caps = [strategyCeilingUsdMicro, requestedUsdMicro].filter(v => v !== null);
    if (!caps.length)
      return hold('native_budget_unknown', 'objective_native_budget_unknown',
        'Holding this job: no size estimate is available for this strategy.', nativeFields);
    const gross = Math.min(...caps);
    if (gross - worstCallUsdMicro <= 0)
      return hold('budget_too_small', 'budget_too_small',
        `Holding this job: ${usdText(gross)} of total spend cannot cover a worst-case ${usdText(worstCallUsdMicro)} call.`, nativeFields);
    let chunkId = 'job', usefulValue = friendValue;
    if (Array.isArray(job.chunkCandidates)) {
      const fitting = job.chunkCandidates.map((chunk, i) => ({id:chunk.id ?? `chunk-${i}`, usdMicro:micro(chunk.usdMicro, 'chunk usd'),
        friendValue:chunk.friendValue})).filter(chunk => chunk.usdMicro === gross);
      if (!fitting.length) return hold('chunk_value_unknown', 'objective_chunk_value_unknown',
        'Holding because the job has no declared stoppable chunk at its dollar cap.', nativeFields);
      chunkId = fitting[0].id;
      if (automatic && input.decide === undefined) usefulValue = num(fitting[0].friendValue, 'chunk friend value');
    }
    // The chance constraint is in the slack; a chosen action must still have positive useful value.
    if (automatic && input.decide === undefined && !(usefulValue > 0))
      return hold('no_value', 'objective_no_value', 'Holding this job: it has no value to lend for.', nativeFields);
    const native = gross - worstCallUsdMicro;
    const reasonText = `Lending now in allowance points · no measured usage rate yet. Allowance: ${pointsText(reservePointsMicro[weeklyResource])} ` +
      'weekly points, checked against the live meter while the job runs.';
    const d = {...shownBase, ...nativeFields, admitted:true, reasonCode:'objective_lend_native', reasonText,
      ...(ruleReasonCode ? {ruleReasonCode} : {}), conversion:'native_window',
      maximumExposureUsd:gross / MICRO, nativeMaxBudgetUsd:native / MICRO};
    return {...d, reason:'lend', projection:objectiveProjection(d), exposureUsdMicro:gross, nativeBudgetUsdMicro:native,
      reservePointsMicro, worstCallUsdMicro, chunkId, objectiveEvaluation:null, conversion:'native_window', modelForecasts};
  };

  // Hard holds, most specific first.
  if (stopped === true) return hold('stopped', 'objective_stopped', 'Lending is stopped.');
  if (!fresh || !readable)
    return hold('usage_unknown', 'objective_usage_unknown', 'Holding because current usage or committed work is unknown.');
  const earliestReset = Math.min(...ids.map(id => windows[id].resetAtMs));
  if (now + wallMs + uncertaintyMs + stopMs >= earliestReset)
    return hold('reset', 'objective_reset', 'Holding because this job cannot finish before the next reset.');
  if (!gates || !['consent', 'limits', 'funding', 'stopping'].every(k => gates[k] === true))
    return hold('gate_closed', 'objective_gate_closed', 'Holding because a required control is not confirmed.');
  // An injected rule decides automatic jobs. A job the owner approves by hand is decided below on measured spare, as the
  // automatic owner-use estimate does not decide a manual request.
  if (input.decide !== undefined && automatic) {
    let rule;
    try { rule = evaluateLendingRule(input, input.decide); }
    catch (error) {
      // Stable evidence diagnostics, never arbitrary text from an injected callback.
      const reasons = {
        quota_registry_missing:'the quota registry is missing',
        native_cost_bound_unknown:'the native cost bound is missing or incompatible',
        quota_registry_unsupported:'the quota registry evidence is unsupported',
        rule_seam_quota_unit_unsupported:'the rule seam requires capacity 100 in quota percent',
        rule_seam_rolling_unsupported:'rolling quota windows are unsupported by the rule seam',
        quota_registry_charge_mismatch:'the registry charge does not match the gross reservation',
      };
      let code;
      try { code = error?.code; } catch { /* A callback may throw an object with a throwing getter. */ }
      return hold('usage_unknown', 'rule_evidence_unknown',
        typeof code === 'string' && Object.hasOwn(reasons, code) ? `Holding because ${reasons[code]} (${code}).`
          : 'Holding because the injected rule or its evidence is incomplete.',
        {ruleReasonCode:lendingRuleErrorCode(error)});
    }
    const protectionSource = sourceMap(ids, 'injected_rule');
    const fields = {strategyId:'injected_rule', strategyExplanation:'An explicitly supplied pure lending rule.',
      protectionSource, lendablePoints:pointsMap(ids, id => rule.lendableMicro[id]),
      protectedOwnerPoints:pointsMap(ids, id => Math.max(0, WINDOW_CAP_MICRO - windows[id].usedMicro -
        (windows[id].uncertaintyMicro ?? 0) - windows[id].committedMicro - rule.lendableMicro[id]))};
    if (!rule.admitted) return hold('owner_reserve', rule.fit ? 'rule_hold' : 'rule_resource_fit',
      rule.fit ? rule.reason : 'Holding because this job does not fit both quota windows.',
      {...fields, ruleReasonCode:rule.reasonCode});
    const gross = rule.grossUsdMicro;
    if (nativeWindows) return nativeLend({reserve:rule.reservePointsMicro, fields, ruleReasonCode:rule.reasonCode});
    if (strategyCeilingUsdMicro !== null && gross > strategyCeilingUsdMicro)
      return hold('request_too_large', 'objective_request_too_large',
        'Holding because this job exceeds your strategy limit.', fields);
    if (gross <= worstCallUsdMicro)
      return hold('budget_too_small', 'budget_too_small',
        'Holding because this job cannot cover one worst-case call.', fields);
    // Never invent a partial checkpoint for a rule that evaluated the whole request.
    if (Array.isArray(job.chunkCandidates) && !job.chunkCandidates.some(c => c.usdMicro === gross))
      return hold('chunk_value_unknown', 'objective_chunk_value_unknown',
        'Holding because the requested gross exposure has no declared stoppable chunk.', fields);
    const native = gross - worstCallUsdMicro;
    const d = {...shownBase, ...fields, admitted:true, reasonCode:'objective_lend', reasonText:rule.reason,
      ruleReasonCode:rule.reasonCode,
      maximumExposureUsd:gross / MICRO, nativeMaxBudgetUsd:native / MICRO};
    return {...d, reason:'lend', projection:objectiveProjection(d), exposureUsdMicro:gross,
      nativeBudgetUsdMicro:native, reservePointsMicro:rule.reservePointsMicro, worstCallUsdMicro,
      chunkId:job.chunkCandidates?.find(c => c.usdMicro === gross)?.id ?? 'job', objectiveEvaluation:null};
  }
  if (!strategyConfigReady(strategy, normalizedStrategyConfig))
    return hold('strategy_config_unknown', 'objective_strategy_config_unknown',
      `Holding because ${strategyText}`, {protectionSource:sourceMap(ids, 'strategy')});

  const pointsPerUsd = Object.fromEntries(ids.map(id => [id, windows[id].pointsPerUsdMicro]));
  const remaining = Object.fromEntries(ids.map(id => [id, Math.max(0, WINDOW_CAP_MICRO - windows[id].usedMicro -
    (windows[id].uncertaintyMicro ?? 0) - windows[id].committedMicro)]));
  let useHistory = false;
  let modelProtection = null;
  const automaticReserveMicro = Object.fromEntries(ids.map(id => [id, 0]));
  if (automatic) {
    if (frozenProtectionSource !== null && !['history','model'].includes(frozenProtectionSource))
      throw new TypeError('invalid frozen protection source');
    // The history band's reserves bind only the ids of a history decision, so they are read only when history is used.
    const calibrated = wholeWeekReserveBand({...band, position});
    useHistory = frozenProtectionSource === 'history' ||
      (frozenProtectionSource === null && calibrated.rank <= calibrated.n);
    if (useHistory) Object.assign(automaticReserveMicro,bandReserves({band, position, ids}).reservesMicro);
    else {
      // The default is the continuous Gamma model (paper 06); a supplied model replaces it, e.g. a cross-check.
      const model = demandModel ?? CONTINUOUS_DEMAND_MODEL;
      modelProtection = demandModelKind(model) === null ? {problem: 'demand_model_unavailable'}
        : protectByModel({demandModel: model, ids, windows, remaining, position, now, modelDataByResource});
      if (modelProtection.problem) {
        return hold(modelProtection.problem, modelProtection.problem,
          MODEL_PROBLEM_TEXT[modelProtection.problem] ?? MODEL_PROBLEM_TEXT.demand_model_invalid,
          {protectionSource:sourceMap(ids,'model')});
      }
      if (modelProtection.predictiveFeasible === false) {
        return hold('owner_reserve', 'objective_predictive_infeasible',
          'Holding this job: at this protection level the demand model cannot keep the owner windows protected within its risk budget.',
          {protectionSource:sourceMap(ids,'model'), demandModelId:modelProtection.modelId,
            demandModelLabel:modelProtection.modelLabel});
      }
      Object.assign(automaticReserveMicro,modelProtection.reservesMicro);
    }
  }
  const automaticLendableMicro = Object.fromEntries(ids.map(id => [id, Math.max(0, remaining[id] - automaticReserveMicro[id])]));
  const selected = lendableByStrategy({id:strategy,
    resources:ids.map(id => ({id, kind:windows[id].kind, remainingMicro:remaining[id], lentMicro:windows[id].lentMicro})),
    automaticLendableMicro, config:normalizedStrategyConfig});
  const slack = selected.lendableMicro;
  const reservesMicro = Object.fromEntries(ids.map(id => [id, remaining[id] - slack[id]]));
  const protectionSource = sourceMap(ids, automatic ? (useHistory ? 'history' : 'model') : 'strategy');
  const explained = {...shownBase, protectionSource,
    demandModelId:modelProtection?.modelId??null, demandModelLabel:modelProtection?.modelLabel??null,
    protectedOwnerPoints: pointsMap(ids, id => reservesMicro[id]), lendablePoints: pointsMap(ids, id => slack[id])};
  const holdWith = (reason, reasonCode, reasonText, fields = {}) => hold(reason, reasonCode, reasonText, {...explained, ...fields});

  // Preserve each scenario's ordered owner attempts, values, and atomicity. A scenario is never collapsed into one divisible weekly demand.
  let ownerScenarios = null;
  if (automatic && !modelProtection && !(nativeWindows && input.pointsOnly === true)) {
    const scenarioIds = new Set();
    if (!owner || !Array.isArray(owner.scenarios))
      return holdWith('owner_scenarios_unknown','objective_owner_scenarios_unknown',
        'Holding because the history protection source has no declared owner service scenarios.');
    ownerScenarios = probabilities(owner.scenarios.map((s, i) => {
      const id = s.id ?? `owner-${i}`;
      if (typeof id !== 'string' || !id || id === '__proto__' || scenarioIds.has(id) || !Array.isArray(s.attempts) || s.attempts.length > 128)
        throw new TypeError('invalid owner scenario');
      scenarioIds.add(id);
      return {id, probability: s.probability, attempts: s.attempts.map(a => {
        if (typeof a.atomic !== 'boolean') throw new TypeError('owner attempt atomicity must be explicit');
        const need = exactRecord(a.need, ids, 'owner demand');
        return {need: Object.fromEntries(ids.map(resourceId => [resourceId, num(need[resourceId], 'owner demand')])),
          value: num(a.value, 'owner service value'), atomic: a.atomic};
      })};
    }));
  } else if (automatic && modelProtection?.ownerScenarios) ownerScenarios = probabilities(modelProtection.ownerScenarios);
  const capacityPoints = ids.map(id => remaining[id] / MICRO);
  const costOf = usd => Object.fromEntries(ids.map(id => [id, pointsForUsdMicro(usd, pointsPerUsd[id])]));
  const lossOfCost = automatic && modelProtection?.lossOfCost ? modelProtection.lossOfCost : null;
  const pointsOf = usdMicro => Object.fromEntries(ids.map(id => [id, costOf(usdMicro)[id] / MICRO]));
  const lossAt = automatic ? usdMicro => (lossOfCost ? lossOfCost(pointsOf(usdMicro))
    : lossOf(ownerScenarios.map(s => ({...s, attempts: s.attempts.map(a => ({...a,
      need: ids.map(id => a.need[id])}))})), ids.map(id => costOf(usdMicro)[id] / MICRO), capacityPoints).expected) : null;
  // Native-window mode has no rate to convert a dollar request into points: the points hold and the live meter guard are its
  // limit, and the request's dollar cap only narrows the native dollar budget (nativeLend). So the request's harm is not priced.
  const harmRequested = automatic && requestedUsdMicro !== null && !nativeWindows ? lossAt(requestedUsdMicro) : null;

  if (slack[weeklyResource] === 0)
    return holdWith('owner_reserve', 'objective_owner_reserve',
      automatic
        ? `Holding this job: all ${pointsText(remaining[weeklyResource])} remaining weekly points are reserved by your current protection source.`
        : `Holding this job: all ${pointsText(remaining[weeklyResource])} remaining weekly points are kept by your selected lending strategy.`,
      {bindingWindow: weeklyResource, expectedOwnerHarm: harmRequested});
  const lendNow = slack[weeklyResource];
  if (lendNow === 0)
    return holdWith('defer', 'objective_defer',
      'Holding this job: its spare capacity is kept for queued work that can still use it.',
      {bindingWindow: weeklyResource, expectedOwnerHarm: harmRequested});
  if (nativeWindows) {
    // A reset-indexed schedule prices its actions in converted points; without a conversion it cannot be checked.
    if (resetIndexedSchedule !== null)
      return holdWith('queue_unknown', 'objective_queue_unknown',
        'Holding because the queued schedule needs a usage rate this account has not shown yet.');
    return nativeLend({reserve:slack, fields:explained, modelForecasts:modelProtection?.forecasts ?? null});
  }

  // Gross exposure is bounded by spare, the job request and the owner's total-spend cap.
  const spareUsd = Object.fromEntries(ids.map(id => [id, usdForPointsMicro(id === weeklyResource ? lendNow : slack[id], pointsPerUsd[id])]));
  const spareMin = Math.min(...ids.map(id => spareUsd[id]));
  const grossLimit = chunkLimitUsdMicro({sizeUsdMicro:spareMin, jobLimitUsdMicro:requestedUsdMicro,
    ownerLimitUsdMicro:strategyCeilingUsdMicro}) ?? 0;
  const exposureFields = {
    bindingWindow: grossLimit === spareMin ? ids.find(id => spareUsd[id] === spareMin) : null,
    maximumExposureUsd: grossLimit / MICRO,
    expectedOwnerHarm: automatic ? (harmRequested ?? lossAt(grossLimit)) : null,
  };
  if (grossLimit <= 0 || grossLimit - worstCallUsdMicro <= 0)
    return holdWith('budget_too_small', 'budget_too_small',
      `Holding this job: ${usdText(grossLimit)} of total spend cannot cover a worst-case ${usdText(worstCallUsdMicro)} call.`,
      exposureFields);

  if (!automatic) {
    let chunkId = 'job', gross = grossLimit;
    if (Array.isArray(job.chunkCandidates)) {
      const chunkIds = new Set();
      const candidates = job.chunkCandidates.map((chunk, i) => {
        const id = chunk.id ?? `chunk-${i}`;
        if (typeof id !== 'string' || !id || id === '__proto__' || chunkIds.has(id)) throw new TypeError('invalid chunk identity');
        chunkIds.add(id);
        return {id, usdMicro:micro(chunk.usdMicro, 'chunk usd')};
      }).filter(chunk => chunk.usdMicro > 0 && chunk.usdMicro <= grossLimit)
        .sort((a, b) => b.usdMicro - a.usdMicro || a.id.localeCompare(b.id));
      if (!candidates.length) return holdWith('chunk_value_unknown', 'objective_chunk_value_unknown',
        'Holding this job because no declared chunk fits the selected strategy.', exposureFields);
      ({id:chunkId, usdMicro:gross} = candidates[0]);
    }
    if (gross - worstCallUsdMicro <= 0)
      return holdWith('budget_too_small', 'budget_too_small',
        `Holding this job: ${usdText(gross)} of total spend cannot cover a worst-case ${usdText(worstCallUsdMicro)} call.`, exposureFields);
    const native = gross - worstCallUsdMicro, reservePointsMicro = costOf(gross);
    const reasonText = strategy === 'manual_approval'
      ? `Lending ${pointsText(reservePointsMicro[weeklyResource])} points after your approval. The automatic owner-use estimate does not decide this manual request.`
      : `Lending ${pointsText(reservePointsMicro[weeklyResource])} points under the ${strategy} strategy. ${strategyText}`;
    const d = {...explained, friendValue:null, ...exposureFields, maximumExposureUsd:gross / MICRO,
      nativeMaxBudgetUsd:native / MICRO, admitted:true, reasonCode:'objective_lend', reasonText};
    return {...d, reason:'lend', projection:objectiveProjection(d), exposureUsdMicro:gross,
      nativeBudgetUsdMicro:native, reservePointsMicro, worstCallUsdMicro, chunkId, objectiveEvaluation:null};
  }

  // Each declared chunk is an independently useful checkpoint. Without a value for a partial chunk, do not apply the full-job value to it.
  let chunks;
  if (Array.isArray(job.chunkCandidates)) {
    const chunkIds = new Set();
    chunks = job.chunkCandidates.map((chunk, i) => {
      const id = chunk.id ?? `chunk-${i}`;
      if (typeof id !== 'string' || !id || id === '__proto__' || chunkIds.has(id)) throw new TypeError('invalid chunk identity');
      chunkIds.add(id);
      return {id, usdMicro: micro(chunk.usdMicro, 'chunk usd'), usefulValue: num(chunk.friendValue, 'chunk friend value')};
    });
  } else {
    // A job reserves its whole request, so partial fills are refused (no chunk value covers a part). A request above the spare, or
    // above the owner's per-job limit, holds, and the hold names the binding limit.
    if (requestedUsdMicro !== null && grossLimit < requestedUsdMicro) {
      if (strategyCeilingUsdMicro !== null && strategyCeilingUsdMicro < spareMin)
        return holdWith('request_too_large', 'objective_request_too_large',
          `Holding this job: it asks for more than your strategy limit of ${usdText(strategyCeilingUsdMicro)} allows.`, exposureFields);
      return holdWith('exceeds_spare', 'objective_exceeds_spare',
        `Holding this job: it needs ${usdText(requestedUsdMicro)}, and ${usdText(spareMin)} is spare now.`, exposureFields);
    }
    chunks = [{id: 'job', usdMicro: grossLimit, usefulValue: friendValue}];
  }
  chunks = chunks.filter(chunk => chunk.usdMicro > 0 && chunk.usdMicro <= grossLimit);
  if (chunks.length === 0)
    return holdWith('budget_too_small', 'budget_too_small',
      `Holding this job: ${usdText(grossLimit)} of spare capacity cannot cover a useful chunk and its worst-case call.`, exposureFields);

  let scheduleDecision = null, scheduledChunk = null, scheduleObjective = null;
  if (resetIndexedSchedule !== null) {
    try {
      // The schedule is compared by expected useful value, with its owner-loss probability capped at epsilon.
      scheduleDecision = chooseResetIndexedSchedule({...resetIndexedSchedule,
        maxRisk:rational(...PROTECTION_POSITIONS[position].epsilonFraction.map(BigInt))});
    } catch {
      return holdWith('queue_unknown','objective_queue_unknown',
        'Holding because the reset-indexed schedule is incomplete or does not prove the safety envelope.',exposureFields);
    }
    if (scheduleDecision.choice === 'none')
      return holdWith('no_value','objective_no_value',
        'Holding because no safe supplied reset-indexed schedule has positive value.',exposureFields);
    const selectedSchedule = resetIndexedSchedule.candidates.find(candidate => candidate.id === scheduleDecision.choice);
    if (!selectedSchedule || selectedSchedule.firstActionId === null)
      return holdWith('defer','objective_defer',
        'Holding because the selected safe schedule starts after a later reset.',exposureFields);
    scheduledChunk = chunks.find(chunk => chunk.id === selectedSchedule.firstActionId);
    if (!scheduledChunk)
      return holdWith('queue_unknown','objective_queue_unknown',
        'Holding because the selected schedule does not identify a current useful chunk.',exposureFields);
    // Fail closed: a schedule without first-action costs for every resource is an unknown queue, not a throw.
    const scheduledCosts = costOf(scheduledChunk.usdMicro);
    let firstActionMatches = false;
    try {
      const firstCosts = exactRecord(selectedSchedule.firstActionCostsMicro,ids,'first action cost');
      firstActionMatches = ids.every(id => micro(firstCosts[id],'first action cost') === scheduledCosts[id]);
    } catch {
      firstActionMatches = false;
    }
    if (!firstActionMatches)
      return holdWith('queue_unknown','objective_queue_unknown',
        'Holding because the reset-indexed schedule has no first-action cost that matches the current chunk.',exposureFields);
    const row = scheduleDecision.evaluations.find(item => item.id === scheduleDecision.choice);
    scheduleObjective = {id:row.id,feasible:true,
      usefulValue:Number(row.usefulValue.n)/Number(row.usefulValue.d),
      loss:Number(row.expectedLoss.n)/Number(row.expectedLoss.d),
      objective:Number(row.score.n)/Number(row.score.d),exactScore:`${row.score.n}/${row.score.d}`,
      scheduleOptimality:scheduleDecision.optimality};
  }

  // Strict value test through the chooser: any positive objective beats none; equality holds.
  const decided = chooseLendingAction({
    resources: ids.map(id => ({id, kind: windows[id].kind, remainingMicro: remaining[id], resetAtMs: windows[id].resetAtMs,
      pointsPerUsdMicro: pointsPerUsd[id], pointsPerUsdLowerMicro: windows[id].pointsPerUsdLowerMicro,
      known: true, fresh: true, compatible: true})),
    // A chunk smaller than the worst-call headroom has no native budget. Clamp it to zero so only that chunk is marked
    // budget_too_small by chooseLendingAction; a negative value here would throw and hold every feasible candidate.
    actions: chunks.map(chunk => ({id: chunk.id, costMicro: costOf(chunk.usdMicro),
      usdMicro: Math.max(0, chunk.usdMicro - worstCallUsdMicro), worstCallUsdMicro,
      finishMs: now + wallMs + uncertaintyMs, usefulValue: chunk.usefulValue, permitted: true})),
    scenarios: ownerScenarios,
    gates, band, position, weeklyResource, now, stopMarginMs: stopMs, laterBurnCapacityMicro, strategyCeilingUsdMicro,
    protectedReservesMicro: reservesMicro, protectionSource, lossOfCost,
  });
  const jobEval = decided.evaluations.find(a => a.id === decided.choice);
  const selectedActionEval = scheduledChunk ? decided.evaluations.find(row => row.id === scheduledChunk.id) : null;
  if (scheduledChunk && (!selectedActionEval || !selectedActionEval.feasible))
    return holdWith('schedule_action_unsafe','objective_schedule_action_unsafe',
      'Holding because the selected schedule’s current chunk fails a live resource or finish check.',exposureFields);
  if ((scheduledChunk && scheduleObjective) || (decided.choice !== 'none' && jobEval)) {
    const chunk = scheduledChunk ?? chunks.find(c => c.id === decided.choice);
    const gross = chunk.usdMicro;
    const native = gross - worstCallUsdMicro;
    const reservePointsMicro = costOf(gross);
    const selectedEvaluation = scheduleObjective ?? jobEval;
    exposureFields.expectedOwnerHarm = selectedEvaluation.loss;
    exposureFields.maximumExposureUsd = gross / MICRO;
    const sourceText = useHistory
      ? `Protection source: history (whole-week conformal band at ε=${epsilonOf(position)}).`
      : `Protection source: model (${modelProtection.modelLabel}).`;
    const modelText = useHistory ? '' : ' Lending what the active demand model leaves unused.';
    const scheduleText = scheduleObjective ? ` Selected the finite reset-indexed schedule ${scheduleObjective.id} by exact utility score.` : '';
    const reasonText = `Lending ${pointsText(reservePointsMicro[weeklyResource])} points: ${pointsText(slack[weeklyResource])} weekly points are spare after protecting your expected use. ${sourceText}${modelText}${scheduleText}`;
    const d = {...explained, friendValue: scheduleObjective?.usefulValue ?? chunk.usefulValue, ...exposureFields, nativeMaxBudgetUsd: native / MICRO, admitted: true,
      reasonCode: 'objective_lend', reasonText};
    return {...d, reason: 'lend', projection: objectiveProjection(d), exposureUsdMicro: gross,
      nativeBudgetUsdMicro: native, reservePointsMicro, worstCallUsdMicro, chunkId: chunk.id,
      objectiveEvaluation: scheduleObjective ?? jobEval, modelForecasts:modelProtection?.forecasts??null,
      scheduleDecision};
  }
  // Not chosen: no feasible action has strictly positive expected useful value. Owner harm is bounded by the
  // chance constraint in the protected slack, not traded against value here.
  return holdWith('no_value', 'objective_no_value', 'Holding this job: it has no value to lend for.', exposureFields);
}
