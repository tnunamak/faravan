// Model-conditioned day-one protection for one resource/window.
// Ported from research capacity-pooling/lending-paper-2026-10-23/dayone.mjs.
// Binary64 posterior arithmetic is conditional on the declared uniform-total prior; it is not a
// distribution-free certificate for an individual owner.

function finite(value, name, min = 0) {
  if (!Number.isFinite(value) || value < min) throw new TypeError(name);
  return value;
}
function probability(value, name) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) throw new TypeError(name);
  return value;
}

export function epsilonForLambda(lambda) {
  if (![2, 4, 10].includes(lambda)) throw new TypeError('lambda');
  return 1 / lambda;
}

// Under Model I, remaining demand d after n observed arrivals by exposure u has
// weights choose(n+d,n)*(1-u)^d. The common u^n likelihood term cancels.
export function uniformTotalPosterior({capacity = 100, count, exposureFraction}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000 ||
      !Number.isSafeInteger(count) || count < 0 || count > capacity) throw new TypeError('capacity/count');
  if (!Number.isFinite(exposureFraction) || exposureFraction < 0 || exposureFraction > 1 ||
      (exposureFraction === 0 && count !== 0)) throw new TypeError('exposureFraction');
  if (exposureFraction === 1) return [{amount: 0, probability: 1}];
  const logs = [];
  let logChoose = 0;
  for (let total = count; total <= capacity; total++) {
    if (total > count) logChoose += Math.log(total / (total - count));
    logs.push(logChoose + (total - count) * Math.log1p(-exposureFraction));
  }
  const max = Math.max(...logs);
  const weights = logs.map(value => Math.exp(value - max));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((weight, index) => ({amount: index, probability: weight / sum}));
}

export function finiteQuantile(atoms, alpha) {
  probability(alpha, 'alpha');
  if (!Array.isArray(atoms) || atoms.length === 0) throw new TypeError('atoms');
  // Validate the entire coordinate before crossing, and never reorder caller data.
  for (const atom of atoms) {
    if (!Number.isFinite(atom?.probability) || atom.probability < 0 || !Number.isFinite(atom?.amount))
      throw new TypeError('atom');
  }
  const ordered = [...atoms].sort((a, b) => a.amount - b.amount);
  let cumulative = 0;
  for (const atom of ordered) {
    cumulative += atom.probability;
    if (cumulative >= 1 - alpha) return atom.amount;
  }
  return ordered.at(-1).amount;
}

// Preallocated resource/horizon risk is supplied by the caller. updateIndex is fixed by
// the durable attempt history for this exact window instance, never by a fresh preview.
export function anytimePriorReserve({capacity = 100, count, exposureFraction, lambda = 10,
  updateIndex = 1, resourceWeight = 1, horizonWeight = 1}) {
  const epsilon = epsilonForLambda(lambda);
  if (!Number.isSafeInteger(updateIndex) || updateIndex < 1 || updateIndex > 1_000_000)
    throw new TypeError('updateIndex');
  finite(resourceWeight, 'resourceWeight');
  finite(horizonWeight, 'horizonWeight');
  if (resourceWeight === 0 || horizonWeight === 0 || resourceWeight > 1 || horizonWeight > 1)
    throw new TypeError('risk weight');
  const eta = epsilon * resourceWeight * horizonWeight / (updateIndex * (updateIndex + 1));
  const atoms = uniformTotalPosterior({capacity, count, exposureFraction});
  return {reserve: finiteQuantile(atoms, eta), epsilon, eta, updateIndex, atoms,
    protectionSource: 'model', guarantee: 'prior-averaged under the declared uniform-total demand model; not owner-calibrated'};
}

// Earlier issued reserves are carried forward by subtracting only observed owner demand
// since their issue. This keeps a later light reading from forgiving an earlier high reserve.
export function carriedPriorReserve(forecasts, cumulativeOwnerDemand, nextReserve) {
  finite(cumulativeOwnerDemand, 'cumulativeOwnerDemand');
  finite(nextReserve, 'nextReserve');
  let reserve = nextReserve;
  for (const row of forecasts ?? []) {
    finite(row.ownerAtIssue, 'ownerAtIssue');
    finite(row.reserve, 'reserve');
    if (row.ownerAtIssue > cumulativeOwnerDemand) throw new TypeError('nonmonotone demand');
    reserve = Math.min(reserve, Math.max(0, row.reserve - (cumulativeOwnerDemand - row.ownerAtIssue)));
  }
  return reserve;
}

function lendable(remaining, reserve, laterBurnCapacity) {
  finite(remaining, 'remaining');
  finite(reserve, 'reserve');
  finite(laterBurnCapacity, 'laterBurnCapacity');
  return Math.max(0, remaining - reserve - laterBurnCapacity);
}

function scalarOutcome(remaining, loan, demand) {
  const ownerLoss = Math.min(demand, remaining) - Math.min(demand, remaining - loan);
  return {loss: ownerLoss, gain: loan - ownerLoss};
}

// Finite one-shot optimizer from the paper. It returns a model witness only; the caller
// still intersects it with verified resources, valued chunks, Stop and finish-before-reset.
export function immediatePriorAction({capacity = 100, count = 0, exposureFraction = 0,
  remaining = capacity, lambda = 10, predictiveAlpha = null, laterBurnCapacity = 0}) {
  epsilonForLambda(lambda);
  finite(remaining, 'remaining');
  finite(laterBurnCapacity, 'laterBurnCapacity');
  const atoms = uniformTotalPosterior({capacity, count, exposureFraction});
  const reserve = predictiveAlpha === null ? 0 : finiteQuantile(atoms, predictiveAlpha);
  const maxLoan = lendable(remaining, reserve, laterBurnCapacity);
  const candidates = [...new Set([0, maxLoan, ...atoms.map(atom => Math.max(0, Math.min(maxLoan, remaining - atom.amount)))])];
  let best = {loan: 0, loss: 0, objective: 0};
  for (const loan of candidates) {
    const loss = atoms.reduce((sum, atom) => sum + atom.probability * scalarOutcome(remaining, loan, atom.amount).loss, 0);
    const objective = loan - lambda * loss;
    if (objective > best.objective + 1e-10 ||
        (Math.abs(objective - best.objective) <= 1e-10 && loss < best.loss)) best = {loan, loss, objective};
  }
  return {...best, reserve, protectionSource: 'model',
    explanation: 'Declared uniform-total demand prior; not calibrated for this owner.'};
}

// Reference implementation only. The paper explicitly says this is not an empirically
// calibrated production session/mark model. It assumes integer unit-point marks (b=1) and
// does not define a joint law for coupled provider windows.
export const MODEL_I_REFERENCE = Object.freeze({
  kind: 'discrete-atoms',
  id: 'model-i-reference',
  label: 'Model I reference only: uniform integer unit-point demand (b=1); marks and coupled-window caveat applies.',
  provenance: '02-day-one-rule.md §6, P3, §9; dayone.mjs; chosen for transparency, not empirically calibrated.',
  supportedResourceCount: 1,
  markBound: () => 1,
  riskBudget({resources, updateIndex, epsilon}) {
    if (!Array.isArray(resources) || resources.length !== 1) throw new TypeError('Model I has no coupled-window law');
    if (!Number.isSafeInteger(updateIndex) || updateIndex < 1 || !Number.isFinite(epsilon) || epsilon <= 0 || epsilon >= 1)
      throw new TypeError('risk budget inputs');
    return epsilon/(updateIndex*(updateIndex+1));
  },
  prior({capacityPoints}) {
    const capacity = Math.ceil(capacityPoints);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 10000) throw new TypeError('capacity');
    return {capacity, law: 'uniform-integer-total'};
  },
  posterior({prior, observations, exposureFraction}) {
    if (prior?.law !== 'uniform-integer-total') throw new TypeError('Model I prior state');
    return uniformTotalPosterior({capacity:prior.capacity, count:observations?.count, exposureFraction});
  },
  ownerScenarios({posterior, resourceId}) {
    return posterior.map((atom, index) => ({id:`model-i-${resourceId}-${index}`, probability:atom.probability,
      attempts:[{need:{[resourceId]:atom.amount}, value:atom.amount, atomic:false}]}));
  },
  ownerServiceValue({demand}) { return demand; },
  harm({capacity, demand, loan}) { return scalarOutcome(capacity, loan, demand).loss; },
});
