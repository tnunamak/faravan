// Exact finite-list comparison for complete reset-indexed schedules.
// This proves optimality only over supplied, schedule-proven candidates.

const ownRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function rational(numerator, denominator = 1n) {
  let n = BigInt(numerator), d = BigInt(denominator);
  if (d === 0n) throw new RangeError('zero denominator');
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n, b = d;
  while (b !== 0n) [a, b] = [b, a % b];
  const divisor = a === 0n ? 1n : a;
  return Object.freeze({n:n / divisor, d:d / divisor});
}
const validRational = value => value && typeof value.n === 'bigint' && typeof value.d === 'bigint' && value.d > 0n;
const requireRational = value => { if (!validRational(value)) throw new TypeError('rational required'); return value; };
const requireNonnegative = value => {
  requireRational(value);
  if (value.n < 0n) throw new RangeError('negative quantity');
  return value;
};
const add = (a,b) => { requireRational(a); requireRational(b); return rational(a.n*b.d+b.n*a.d,a.d*b.d); };
const mul = (a,b) => { requireRational(a); requireRational(b); return rational(a.n*b.n,a.d*b.d); };
const compare = (a,b) => { requireRational(a); requireRational(b); const x=a.n*b.d-b.n*a.d; return x<0n?-1:x>0n?1:0; };
const zero = rational(0n);
const format = value => `${value.n}/${value.d}`;

function completeRationalArray(values, label, expectedLength = null) {
  if (!Array.isArray(values) || values.length === 0 ||
      (expectedLength !== null && values.length !== expectedLength))
    throw new TypeError(`${label} dimensions`);
  for (let index = 0; index < values.length; index++) {
    if (!Object.hasOwn(values, index)) throw new TypeError(`missing ${label} entry`);
    requireNonnegative(values[index]);
  }
  return values;
}

function expected(values, weights) {
  completeRationalArray(weights, 'scenario weight');
  completeRationalArray(values, 'scenario value', weights.length);
  let weightTotal = zero;
  let total = zero;
  for (let index = 0; index < values.length; index++) {
    weightTotal = add(weightTotal, weights[index]);
    total = add(total, mul(values[index], weights[index]));
  }
  if (compare(weightTotal, rational(1n)) !== 0) throw new RangeError('probability sum');
  return total;
}

/**
 * Select a complete reset-indexed schedule by exact expected useful value, among schedules whose owner-loss risk
 * (probability of any loss) is at most maxRisk, the epsilon cap of the binding design. Owner loss is not subtracted
 * from value. Costs use named resource instances, such as short@now, short@after-reset and weekly@same-week. A future
 * resource is never merged into a current balance. `scheduleProven` and every safety-envelope fact must be explicit.
 */
export function chooseResetIndexedSchedule({resources, candidates, weights, maxLoss = null, maxRisk = null} = {}) {
  if (!Array.isArray(resources) || resources.length === 0 || resources.length > 64)
    throw new TypeError('invalid schedule resources');
  for (let index = 0; index < resources.length; index++)
    if (!Object.hasOwn(resources, index)) throw new TypeError('missing schedule resource coordinate');
  const ids = resources.map(resource => resource?.id);
  if (ids.some(id => typeof id !== 'string' || !id || id === '__proto__') || new Set(ids).size !== ids.length ||
      resources.some(resource => !Number.isSafeInteger(resource.capacityMicro) || resource.capacityMicro < 0))
    throw new TypeError('invalid schedule resource identity or capacity');
  if (!Array.isArray(weights) || weights.length === 0 || weights.length > 128) throw new TypeError('invalid weights');
  const normalizedWeights = completeRationalArray(weights, 'scenario weight').slice();
  if (compare(normalizedWeights.reduce(add, zero), rational(1n)) !== 0) throw new RangeError('probability sum');
  if (maxLoss !== null) requireNonnegative(maxLoss);
  if (maxRisk !== null) {
    requireNonnegative(maxRisk);
    if (compare(maxRisk, rational(1n)) > 0) throw new RangeError('risk limit');
  }
  if (!Array.isArray(candidates) || candidates.length > 256) throw new TypeError('invalid schedule candidates');
  const seen = new Set(['none']);
  const evaluations = [{id:'none', feasible:true, usefulValue:zero, expectedLoss:zero, risk:zero, score:zero,
    firstActionId:null, reasons:[]}];
  for (const candidate of candidates) {
    if (!ownRecord(candidate) || typeof candidate.id !== 'string' || !candidate.id ||
        candidate.id === '__proto__' || seen.has(candidate.id)) throw new TypeError('invalid schedule candidate id');
    seen.add(candidate.id);
    if (!ownRecord(candidate.costsMicro) || Object.keys(candidate.costsMicro).length !== ids.length ||
        ids.some(id => !Object.hasOwn(candidate.costsMicro, id))) throw new TypeError('schedule cost identity mismatch');
    const costs = ids.map(id => candidate.costsMicro[id]);
    if (costs.some(value => !Number.isSafeInteger(value) || value < 0)) throw new TypeError('invalid schedule cost');
    const usefulValues = completeRationalArray(candidate.usefulValues, 'scenario useful value', weights.length);
    const ownerLosses = completeRationalArray(candidate.ownerLosses, 'scenario loss', weights.length);
    const usefulValue = expected(usefulValues, normalizedWeights);
    const expectedLoss = expected(ownerLosses, normalizedWeights);
    const lossIndicators = ownerLosses.map(loss => compare(loss, zero) > 0 ? rational(1n) : zero);
    const anyLoss = expected(lossIndicators, normalizedWeights);
    if (!Object.hasOwn(candidate, 'firstActionId')) throw new TypeError('missing first action');
    const score = usefulValue;
    if (candidate.firstActionId !== null &&
        (typeof candidate.firstActionId !== 'string' || !candidate.firstActionId || candidate.firstActionId === '__proto__'))
      throw new TypeError('invalid first action');
    const envelope = candidate.envelope;
    const reasons = [];
    if (candidate.scheduleProven !== true) reasons.push('schedule_unproven');
    if (!ownRecord(envelope)) reasons.push('safety_envelope_unknown');
    else for (const key of ['stoppable','finishesBeforeReset','unknownUsageHeld','ownerCapFits'])
      if (envelope[key] !== true) reasons.push('safety_envelope:' + key);
    costs.forEach((cost,index) => {
      if (cost > resources[index].capacityMicro) reasons.push('resource_fit:' + ids[index]);
    });
    if (maxLoss !== null && compare(expectedLoss, maxLoss) > 0) reasons.push('max_loss');
    if (maxRisk !== null && compare(anyLoss, maxRisk) > 0) reasons.push('max_risk');
    evaluations.push({id:candidate.id, feasible:reasons.length===0, usefulValue, expectedLoss,
      risk:anyLoss, score, firstActionId:candidate.firstActionId ?? null, reasons});
  }
  let best = evaluations[0];
  for (const row of evaluations.slice(1)) {
    if (!row.feasible || compare(row.score, zero) <= 0) continue;
    const scoreOrder = compare(row.score, best.score);
    if (scoreOrder > 0 || (scoreOrder === 0 &&
        (compare(row.expectedLoss, best.expectedLoss) < 0 ||
         (compare(row.expectedLoss, best.expectedLoss) === 0 && row.id < best.id)))) best = row;
  }
  return {choice:best.id, firstActionId:best.firstActionId, score:best.score,
    usefulValue:best.usefulValue, expectedLoss:best.expectedLoss, evaluations,
    optimality:'exact finite-list optimum under the supplied scenario law and proven schedules'};
}

export const rationalText = format;
