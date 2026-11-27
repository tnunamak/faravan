// M1 default demand model: continuous Gamma demand (paper 06 sections 3-8; declared default research 08-default-prior.md).
// Pure: the caller passes nowMs and every window reading; no clock, I/O or provider calls. The numerical kernels are the
// reference port in lending-continuous.mjs. Every constant here is traced in ~/.tmp/faravan-extract/evidence/m1-stageb-1023/NOTES.md.
//
// Decision rule (binding, 2026-10-23): maximize expected useful lent value subject to the joint predictive chance
// constraint P(harm(x)) <= epsilon. The chance level for issuance n is its ledger budget eta_n = epsilon/[n(n+1)], so the
// first issuance of a window episode spends epsilon/2. The loan is the largest x that meets that chance constraint.
// Owner loss is never subtracted from value. Latest-vintage carry only (binding carry rule).
import {loss, nestedCdf, posterior, quantile, survival} from './lending-continuous.mjs';
import {carriedReserve, checkUpdateIndex, createLedgerState, issuanceTarget, ledgerStateFromRows} from './lending-risk-ledger.mjs';

// Expected joint loss is the integral of the joint risk over [0, upper] (paper 06 sections 4 and 7). Near a reset, an endpoint
// exponent can be small and the risk can change almost like a step, so two agreeing Gaussian estimates are not a decision
// certificate. The Gauss rule below supplies a display estimate only. Action comparisons use outward-rounded monotone Riemann
// bounds and refine the panel with the largest width * risk change until the comparison is decided or its evaluation budget ends.
// The current weight is w=1, so each panel's weight mass is its width and half-mass bisection is its midpoint. The initial mesh
// and 10,000 risk-evaluation budget are implementation choices; paper 06 section 10 names numerical methods but sets no values.
const GAUSS8_NODES = Object.freeze([0.1834346424956498, 0.5255324099163290, 0.7966664774136267, 0.9602898564975363]);
const GAUSS8_WEIGHTS = Object.freeze([0.3626837833783620, 0.3137066458778873, 0.2223810344533745, 0.1012285362903763]);
const LOSS_BULK_PANELS = 16;
const LOSS_GRADED_LEVELS = 20;
const LOSS_GRADING_START = 1 / 16;
const LOSS_MAX_RIEMANN_EVALUATIONS = 10_000;

// Panel edges: bulkPanels uniform panels on [0, upper - d], then the dyadic edges upper - d / 2^k for k = 1..gradedLevels,
// then upper, where d = LOSS_GRADING_START * upper.
function lossEdges(upper, bulkPanels, gradedLevels) {
  const d = upper * LOSS_GRADING_START, edges = [];
  for (let i = 0; i <= bulkPanels; i++) edges.push((upper - d) * i / bulkPanels);
  for (let k = 1; k <= gradedLevels; k++) edges.push(upper - d * 2 ** -k);
  edges.push(upper);
  return edges;
}

// Composite 8-point Gauss-Legendre over the edges, each panel split into `subdivisions` equal parts.
function gaussOverEdges(f, edges, subdivisions) {
  let total = 0;
  for (let e = 0; e + 1 < edges.length; e++) {
    const step = (edges[e + 1] - edges[e]) / subdivisions;
    for (let q = 0; q < subdivisions; q++) {
      const half = step / 2, mid = edges[e] + q * step + half;
      let panel = 0;
      for (let j = 0; j < GAUSS8_NODES.length; j++) panel += GAUSS8_WEIGHTS[j] * (f(mid - half * GAUSS8_NODES[j]) + f(mid + half * GAUSS8_NODES[j]));
      total += panel * half;
    }
  }
  return total;
}

function heapPush(heap, panel) {
  let index = heap.length;
  heap.push(panel);
  while (index > 0) {
    const parent = (index - 1) >> 1;
    if (heap[parent].priority >= panel.priority) break;
    heap[index] = heap[parent];
    index = parent;
  }
  heap[index] = panel;
}

function heapPop(heap) {
  const first = heap[0], last = heap.pop();
  if (heap.length > 0) {
    let index = 0;
    while (true) {
      const left = index * 2 + 1, right = left + 1;
      if (left >= heap.length) break;
      const child = right < heap.length && heap[right].priority > heap[left].priority ? right : left;
      if (heap[child].priority <= last.priority) break;
      heap[index] = heap[child];
      index = child;
    }
    heap[index] = last;
  }
  return first;
}

function nextUp(value) {
  if (Number.isNaN(value) || value === Infinity) return value;
  if (value === 0) return Number.MIN_VALUE;
  // Keep numerical scratch local: snapshots must not write storage shared with admission.
  const roundingView = new DataView(new ArrayBuffer(8));
  roundingView.setFloat64(0, value);
  const bits = roundingView.getBigUint64(0);
  roundingView.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n);
  return roundingView.getFloat64(0);
}
function nextDown(value) {
  if (Number.isNaN(value) || value === -Infinity) return value;
  if (value === 0) return -Number.MIN_VALUE;
  const roundingView = new DataView(new ArrayBuffer(8));
  roundingView.setFloat64(0, value);
  const bits = roundingView.getBigUint64(0);
  roundingView.setBigUint64(0, value > 0 ? bits - 1n : bits + 1n);
  return roundingView.getFloat64(0);
}

function monotonePanel(left, right, leftValue, rightValue) {
  if (leftValue === 0 && rightValue === 0) return {left, right, leftValue, rightValue, lower:0, upper:0, priority:0};
  const weight = right - left;
  const lower = nextDown(leftValue * nextDown(weight));
  const upper = nextUp(rightValue * nextUp(weight));
  const riskChange = rightValue - leftValue;
  return {left, right, leftValue, rightValue, lower, upper, priority: weight * riskChange};
}

function monotoneEnclosure(risk, upper, {bulkPanels, gradedLevels, maxEvaluations}) {
  if (upper === 0) return {bounds:{lower:0, upper:0}, evaluations:0, initialLower:0, initialUpper:0,
    relationTo:threshold => 0 > threshold ? 'above' : 0 < threshold ? 'below' : 'unresolved', refine:() => false};
  const edges = lossEdges(upper, bulkPanels, gradedLevels);
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < edges.length)
    throw new RangeError('expected-loss evaluation budget is below the initial mesh');
  const valueAt = point => {
    if (values.has(point)) return values.get(point);
    if (evaluations >= maxEvaluations) return null;
    const value = risk(point);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError('expected loss unresolved');
    evaluations++;
    values.set(point, value);
    return value;
  };
  const values = new Map();
  let evaluations = 0, exactLower = 0, exactUpper = 0;
  const heap = [];
  let leftValue = valueAt(edges[0]);
  for (let index = 0; index + 1 < edges.length; index++) {
    const left = edges[index], right = edges[index + 1], rightValue = valueAt(right);
    if (rightValue < leftValue) throw new RangeError('expected loss unresolved');
    exactLower += (right - left) * leftValue;
    exactUpper += (right - left) * rightValue;
    heapPush(heap, monotonePanel(left, right, leftValue, rightValue));
    leftValue = rightValue;
  }

  const totals = () => {
    let lower = 0, upperBound = 0;
    for (const panel of heap) {
      lower = nextDown(lower + panel.lower);
      upperBound = nextUp(upperBound + panel.upper);
    }
    return {lower, upper:upperBound};
  };
  let bounds = totals();
  const initialLower = exactLower, initialUpper = exactUpper;
  const relationTo = threshold => bounds.lower > threshold ? 'above' : bounds.upper < threshold ? 'below' : 'unresolved';
  const refine = () => {
    const panel = heap[0];
    if (!panel || panel.priority <= 0) return false;
    const middle = panel.left + (panel.right - panel.left) / 2;
    if (middle === panel.left || middle === panel.right) return false;
    const middleValue = valueAt(middle);
    if (middleValue === null) return false;
    if (middleValue < panel.leftValue || middleValue > panel.rightValue) throw new RangeError('expected loss unresolved');
    heapPop(heap);
    heapPush(heap, monotonePanel(panel.left, middle, panel.leftValue, middleValue));
    heapPush(heap, monotonePanel(middle, panel.right, middleValue, panel.rightValue));
    bounds = totals();
    return true;
  };
  return {get bounds() { return bounds; }, get evaluations() { return evaluations; }, get refinementPriority() { return heap[0]?.priority ?? 0; },
    initialLower, initialUpper,
    relationTo, refine};
}

/**
 * A presentation estimate of the integral of a nondecreasing risk over [0, upper]. Decision comparisons use the separate
 * monotone enclosure below; a pair of matching Gaussian estimates is never treated as a certificate.
 */
export function integrateExpectedLoss(risk, upper, {bulkPanels = LOSS_BULK_PANELS, gradedLevels = LOSS_GRADED_LEVELS} = {}) {
  if (!Number.isFinite(upper) || upper < 0) throw new RangeError('loss upper bound must be finite and nonnegative');
  if (upper === 0) return 0;
  const edges = lossEdges(upper, bulkPanels, gradedLevels);
  return gaussOverEdges(risk, edges, 2);
}

/** Compare a monotone risk integral to a decision threshold using an outward-rounded Riemann enclosure. */
export function compareExpectedLoss(risk, upper, threshold, {bulkPanels = LOSS_BULK_PANELS, gradedLevels = LOSS_GRADED_LEVELS,
  maxEvaluations = LOSS_MAX_RIEMANN_EVALUATIONS} = {}) {
  if (!Number.isFinite(upper) || upper < 0) throw new RangeError('loss upper bound must be finite and nonnegative');
  if (!Number.isFinite(threshold)) throw new TypeError('expected-loss threshold must be finite');
  if (upper === 0) return {relation:threshold > 0 ? 'below' : threshold < 0 ? 'above' : 'unresolved',
    lower:0, upper:0, initialLower:0, initialUpper:0, evaluations:0};
  const enclosure = monotoneEnclosure(risk, upper, {bulkPanels, gradedLevels, maxEvaluations});
  let relation = enclosure.relationTo(threshold);
  while (relation === 'unresolved' && enclosure.refine()) relation = enclosure.relationTo(threshold);
  return {relation, lower:enclosure.bounds.lower, upper:enclosure.bounds.upper,
    initialLower:enclosure.initialLower, initialUpper:enclosure.initialUpper, evaluations:enclosure.evaluations};
}

/** Compare two expected losses; ambiguity after the bounded Riemann refinement makes the action choice hold. */
export function compareExpectedLosses(risk, leftUpper, rightUpper, {bulkPanels = LOSS_BULK_PANELS, gradedLevels = LOSS_GRADED_LEVELS,
  maxEvaluations = LOSS_MAX_RIEMANN_EVALUATIONS} = {}) {
  if (![leftUpper, rightUpper].every(value => Number.isFinite(value) && value >= 0))
    throw new RangeError('loss upper bounds must be finite and nonnegative');
  if (leftUpper === rightUpper) return 0;
  const initialEvaluations = (leftUpper === 0 ? 0 : lossEdges(leftUpper, bulkPanels, gradedLevels).length) +
    (rightUpper === 0 ? 0 : lossEdges(rightUpper, bulkPanels, gradedLevels).length);
  if (!Number.isSafeInteger(maxEvaluations) || maxEvaluations < initialEvaluations)
    throw new RangeError('expected-loss evaluation budget is below the initial meshes');
  const budgetPerSide = leftUpper === 0 || rightUpper === 0 ? maxEvaluations : Math.floor(maxEvaluations / 2);
  const left = monotoneEnclosure(risk, leftUpper, {bulkPanels, gradedLevels, maxEvaluations:budgetPerSide});
  const right = monotoneEnclosure(risk, rightUpper, {bulkPanels, gradedLevels, maxEvaluations:budgetPerSide});
  const relation = () => left.bounds.upper < right.bounds.lower ? -1
    : right.bounds.upper < left.bounds.lower ? 1
    : left.bounds.lower === left.bounds.upper && right.bounds.lower === right.bounds.upper && left.bounds.lower === right.bounds.lower ? 0 : null;
  let order = relation();
  while (order === null && left.evaluations + right.evaluations < maxEvaluations) {
    const selected = left.refinementPriority >= right.refinementPriority ? left : right;
    if (!selected.refine()) {
      const other = selected === left ? right : left;
      if (!other.refine()) break;
    }
    order = relation();
  }
  if (order === null) throw new RangeError('expected loss unresolved');
  return order;
}

export const CONTINUOUS_DEMAND_MODEL_KIND = 'continuous-gamma';
export const CONTINUOUS_DEMAND_MODEL_ID = 'continuous-gamma-v1';
// Paper 06 section 2 and research 08 section 7: the exposure clock is A(t) = K t / 168 hours, with K the regularity multiplier.
export const WEEK_MS = 168 * 3_600_000;
// The declared starting assumption (research 08-default-prior.md, section 7). One versioned configuration object; no prior
// number appears anywhere else. b0 is the scale at regularity K = 1 for a weekly quota of 100 points, and the prior mean
// is b0 (alpha0 - 1) K^-1 (section 7), so the mean weekly demand K b0/(alpha0 - 1) stays fixed when K changes. K is 1 in
// v1 and must not be raised by default (REVIEW-regularity-K-muse: a wrong higher K multiplies harm by 4-5x).
export const OPTIMISTIC_DEFAULT_V1 = Object.freeze({
  version: 'optimistic-default-v1', alpha0: 2, b0: 90 / (Math.sqrt(20) - 1), K: 1, quotaReferencePoints: 100,
});
export const DEFAULT_PRIOR = OPTIMISTIC_DEFAULT_V1;
// M1 unit: micro-points per point, as in lending-objective.mjs.
const MICRO = 1_000_000;
// The one dial: the harm-probability cap (binding design, 2026-10-23). Positions live in lending-objective.mjs.
const DIAL_EPSILONS = Object.freeze([0.1, 0.25, 0.5]);
// Bisection steps for the joint loan, the same count the kernel's nestedAction uses (60 halvings of [0, cap]).
const JOINT_BISECTIONS = 60;
// Bands below this are zero to float precision (see bandQuantile). It sits above the kernel's quantile range, which ends near
// 6e-323, so the kernel is never asked for a band it cannot resolve.
const NEGLIGIBLE_BAND = 1e-300;
const PROVENANCE = 'research capacity-pooling/lending-paper-2026-10-23/06-continuous-closed-form.md, sections 3-8';
const LABEL = 'Continuous Gamma demand under a declared prior; not calibrated to any owner.';

const positive = (x, name) => {
  if (typeof x !== 'number' || !Number.isFinite(x) || x <= 0) throw new TypeError(`${name} must be a positive number`);
  return x;
};
const nonNegative = (x, name) => {
  if (typeof x !== 'number' || !Number.isFinite(x) || x < 0) throw new TypeError(`${name} must be a finite nonnegative number`);
  return x;
};
const time = (x, name) => {
  if (typeof x !== 'number' || !Number.isFinite(x)) throw new TypeError(`${name} must be a finite time`);
  return x;
};
const dial = epsilon => {
  if (!DIAL_EPSILONS.includes(epsilon)) throw new TypeError('epsilon must be 0.10, 0.25 or 0.50');
  return epsilon;
};

/**
 * A declared Gamma prior with its regularity K as a field. `b0` is the scale at K = 1 for a quota of
 * `quotaReferencePoints`; the effective scale at other K and quotas comes from effectivePrior, so K can change
 * without breaking the mean.
 */
export function createContinuousDemandModel({version = 'declared', alpha0, b0, K = 1, quotaReferencePoints = 100} = {}) {
  if (typeof version !== 'string' || !version) throw new TypeError('prior version must be a nonempty string');
  positive(alpha0, 'alpha0');
  positive(b0, 'b0');
  positive(K, 'K');
  positive(quotaReferencePoints, 'quotaReferencePoints');
  return Object.freeze({kind: CONTINUOUS_DEMAND_MODEL_KIND, id: CONTINUOUS_DEMAND_MODEL_ID, label: LABEL,
    provenance: PROVENANCE, prior: Object.freeze({version, alpha0, b0, K, quotaReferencePoints})});
}

export const CONTINUOUS_DEMAND_MODEL = createContinuousDemandModel(DEFAULT_PRIOR);

/**
 * Effective prior at a window quota: the scale is b0_ref (quota / quotaRef) / K (research 08 section 7). Scaling by 1/K
 * keeps the mean weekly demand K b0/(alpha0 - 1) fixed, so a higher K only changes the shape of the weekly variability.
 */
export function effectivePrior(prior, quotaPoints = prior.quotaReferencePoints) {
  positive(quotaPoints, 'quotaPoints');
  const K = positive(prior.K, 'K');
  return {alpha0: prior.alpha0, K, b0: prior.b0 * (quotaPoints / prior.quotaReferencePoints) / K};
}

/**
 * Remaining-window law after owner usage (paper 06 Theorem 1, section 3). Exposure is A(t) = K t/168 weeks since the
 * declared origin, and the remaining shape is K times the weeks to reset. Usage is owner usage since origin in micro-points.
 * uncertaintyMicro is the meter unit v that the reading carries (one whole point, lending-pace50-source.mjs). Where time has
 * passed, the reading bounds the owner usage from above, usage < r + v, and the upper surrogate r + v is the usage: observation
 * rounded_upper_surrogate (paper 06 section 5). The bound holds under floor, nearest or ceiling rounding, and no source declares
 * which. With no declared unit, or at zero exposure, the usage is exact (exact_latent).
 * Returns {k, alpha, b, observation}: remaining shape to reset, posterior shape and scale, and the observation kind.
 */
export function continuousLaw({prior, originAtMs, nowMs, resetAtMs, usedSinceOriginMicro, uncertaintyMicro = 0, quotaPoints = 100}) {
  time(originAtMs, 'originAtMs');
  time(nowMs, 'nowMs');
  time(resetAtMs, 'resetAtMs');
  if (originAtMs > nowMs) throw new RangeError('origin is after now');
  if (!(resetAtMs > nowMs)) throw new RangeError('reset is not in the future');
  const eff = effectivePrior(prior, quotaPoints);
  const exposure = eff.K * (nowMs - originAtMs) / WEEK_MS;
  const usedMicro = nonNegative(usedSinceOriginMicro, 'usedSinceOriginMicro');
  const unitMicro = nonNegative(uncertaintyMicro, 'uncertaintyMicro');
  const observation = exposure > 0 && unitMicro > 0 ? 'rounded_upper_surrogate' : 'exact_latent';
  const usage = (usedMicro + (observation === 'rounded_upper_surrogate' ? unitMicro : 0)) / MICRO;
  const post = posterior({alpha: eff.alpha0, b: eff.b0, exposure, usage, observation});
  return {k: eff.K * (resetAtMs - nowMs) / WEEK_MS, alpha: post.alpha, b: post.b, observation};
}

function priorOf(model) {
  if (!model || model.kind !== CONTINUOUS_DEMAND_MODEL_KIND || !model.prior) throw new TypeError('not a continuous demand model');
  return model.prior;
}

/**
 * Chance-constrained protection for one account, at one dial value (paper 06 sections 4, 6 and 7).
 * Scalar: harm = {D > R - x}. The loan is the largest x with P(harm) <= eta, so x = max(0, R - Q(eta)), where Q is
 * the exact posterior predictive quantile (beta-prime, paper 06 section 3).
 * Joint: harm = {z < x} with z = min(C - X, R - X - Y) (paper 06 section 7). The loan is the largest x with
 * 1 - G(C - x, R - x) <= eta; G is the exact joint CDF. Short points convert by shortPerWeekly, and one latent beta
 * drives both windows.
 * eta = epsilon/[n(n+1)] is the issuance's ledger budget (bayesUpdateBudget). No economic or lambda term appears:
 * for n >= 1, eta <= epsilon/2 < epsilon, so the economic crossing could never bind.
 * Returns the loan, the predictive feasibility, the per-window reserves and a harm(costPoints) function.
 */
export function continuousProtection({model, epsilon, nowMs, weekly, short = null, updateIndex = 1, ledgerState = null,
  quotaPoints = 100}) {
  const prior = priorOf(model);
  dial(epsilon);
  time(nowMs, 'nowMs');
  // The issuance level comes from the risk ledger (issuanceTarget), not from a schedule written here. A bare updateIndex
  // is the ordinal of the next issuance, so the ledger holds ordinal - 1 issuances before it.
  const ledger = ledgerState ?? createLedgerState({epsilon, issuedCount: updateIndex - 1});
  if (ledger.epsilon !== epsilon) throw new RangeError('ledger epsilon does not match the dial');
  const R = nonNegative(weekly.remainingPoints, 'weekly remaining points');
  const eff = effectivePrior(prior, quotaPoints);
  const law = continuousLaw({prior, originAtMs: weekly.originAtMs, nowMs, resetAtMs: weekly.resetAtMs,
    usedSinceOriginMicro: weekly.ownerUsedSinceOriginMicro, uncertaintyMicro: weekly.uncertaintyMicro ?? 0, quotaPoints});
  const eta = issuanceTarget(ledger, law);
  const issued = ledger.issuedCount + 1;
  if (short === null) {
    // The protected reserve is the band itself, P(D > band) = eta. R - band would lose a tiny band near reset to floating
    // point (dot review r2 P2), so the reserve is held directly and the loan is what remains above it.
    const band = bandQuantile({k: law.k, alpha: law.alpha, b: law.b}, eta);
    const predictiveFeasible = band <= R;
    const reserve = predictiveFeasible ? band : R;
    const x = R - reserve;
    return {
      eta, updateIndex: issued, loanWeekly: x, predictiveFeasible, band,
      reservePoints: {weekly: reserve}, lendablePoints: {weekly: x},
      harm({weekly: w = 0, short: s = 0} = {}) {
        if (s !== 0) throw new RangeError('short cost without a short window');
        nonNegative(w, 'weekly cost');
        if (w > R) throw new RangeError('weekly cost exceeds remaining points');
        return loss(R, w, {k: law.k, alpha: law.alpha, b: law.b});
      },
      compareHarm(left, right) {
        const lossAt = ({weekly:w = 0, short:s = 0} = {}) => {
          if (s !== 0) throw new RangeError('short cost without a short window');
          nonNegative(w, 'weekly cost');
          if (w > R) throw new RangeError('weekly cost exceeds remaining points');
          return loss(R, w, {k:law.k, alpha:law.alpha, b:law.b});
        };
        const a = lossAt(left), b = lossAt(right);
        return a < b ? -1 : a > b ? 1 : 0;
      },
    };
  }
  const shortPoints = nonNegative(short.remainingPoints, 'short remaining points');
  const a = positive(short.shortPerWeekly, 'shortPerWeekly');
  time(short.resetAtMs, 'short resetAtMs');
  if (!(short.resetAtMs > nowMs)) throw new RangeError('short reset is not in the future');
  // Equal resets are allowed: kLater = 0 is the paper's section 3 case, and the kernel handles it (nestedCdf, l === 0).
  if (!(short.resetAtMs <= weekly.resetAtMs)) throw new RangeError('short reset must be at or before the weekly reset');
  const C = shortPoints / a;
  const kShort = eff.K * (short.resetAtMs - nowMs) / WEEK_MS;
  const kLater = eff.K * (weekly.resetAtMs - short.resetAtMs) / WEEK_MS;
  const cap = Math.min(C, R);
  // P(harm) when the weekly reserve is r: the owner's joint demand exceeds the window left after the loan R - r. The short
  // reserve is C - x = C - R + r. The search runs on r, not on the loan, so a reserve near zero near reset keeps its value.
  const riskAtReserve = r => 1 - nestedCdf({short: C - R + r, week: r, kShort, kLater, alpha: law.alpha, b: law.b});
  // The same risk as a function of the loan x, for the expected-loss integral.
  const risk = x => riskAtReserve(R - x);
  const harmUpper = ({weekly: w = 0, short: s = 0} = {}) => {
    nonNegative(w, 'weekly cost');
    nonNegative(s, 'short cost');
    const work = Math.max(w, s / a);
    if (work > cap * (1 + 1e-12) + 1e-12) throw new RangeError('joint loan exceeds the protected capacity');
    return Math.min(work, cap);
  };
  const baselineExceedance = riskAtReserve(R);
  const predictiveFeasible = baselineExceedance <= eta;
  let reserve = R;
  if (predictiveFeasible) {
    // hi is always feasible, so the returned reserve meets the chance constraint.
    let lo = R - cap, hi = R;
    for (let i = 0; i < JOINT_BISECTIONS; i++) {
      const mid = (lo + hi) / 2;
      if (riskAtReserve(mid) <= eta) hi = mid; else lo = mid;
    }
    reserve = hi;
  }
  const x = R - reserve;
  return {
    eta, updateIndex: issued, loanWeekly: x, shortDebitPoints: a * x, predictiveFeasible, baselineExceedance,
    reservePoints: {weekly: reserve, short: shortPoints - a * x}, lendablePoints: {weekly: x, short: a * x},
    harm({weekly: w = 0, short: s = 0} = {}) {
      // Binding window: short points over their conversion, weekly points as is (paper 06, section 7).
      const upper = harmUpper({weekly:w, short:s});
      // The short window cannot bind when C >= R. Then the weekly risk is the scalar survival of the total demand, and the loss is
      // the exact scalar capped-mean difference (paper 06, section 7: exact scalar reduction when C >= R).
      if (C >= R) return loss(R, upper, {k: law.k, alpha: law.alpha, b: law.b});
      return integrateExpectedLoss(risk, upper);
    },
    compareHarm(left, right) {
      const leftUpper = harmUpper(left), rightUpper = harmUpper(right);
      if (C >= R) {
        const leftLoss = loss(R, leftUpper, {k:law.k, alpha:law.alpha, b:law.b});
        const rightLoss = loss(R, rightUpper, {k:law.k, alpha:law.alpha, b:law.b});
        return leftLoss < rightLoss ? -1 : leftLoss > rightLoss ? 1 : 0;
      }
      return compareExpectedLosses(risk, leftUpper, rightUpper);
    },
  };
}

// A band below NEGLIGIBLE_BAND is zero to float precision: survival(NEGLIGIBLE_BAND) <= eta means the eta-quantile lies at
// or below it. The kernel's quantile cannot resolve that far down (it throws 'quantile bracket'), and a one-micro-point
// reserve already meets the chance constraint there, so the band is taken as zero and the adapter's minimum applies.
// The joint path needs no such case: its bisection runs on the reserve.
function bandQuantile(law, eta) {
  return survival(NEGLIGIBLE_BAND, law) <= eta ? 0 : quantile(law, eta);
}

// Errors the kernel and ledger raise for inputs the model cannot evaluate. Each maps to one named hold.
function problemOf(error) {
  const message = String(error?.message ?? '');
  if (/impossible (exact|rounded) Gamma observation|nonmonotone/.test(message)) return 'demand_model_exact_usage_required';
  if (/at or before the weekly|short reset/.test(message)) return 'demand_model_coupling_unknown';
  return 'demand_model_invalid';
}

/**
 * Window adapter for the allocator. Inputs and outputs are exact micro-points; continuousProtection does the math
 * in points. `windows[id]` = {kind, remainingMicro, resetAtMs, ownerUsedMicro, uncertaintyMicro, pointsPerUsdMicro}, net of commitments
 * and uncertainty. `modelDataByResource[id]` = {originAtMs, initialOwnerUsedMicro, updateIndex, forecasts}, the
 * persisted cycle state: forecasts are {reservePoints, ownerAtIssue}, with ownerAtIssue the owner usage at issue in
 * points (micro / 1e6, so it round-trips exactly). `quotaPoints` is the window quota that scales the prior.
 *
 * The loan is the fresh chance-constrained loan of this issuance at its budget. Earlier vintages do not cap it (binding
 * carry rule, research 4f816a9). Returns {problem} when the model cannot evaluate, else lendable and reserve micro-points per
 * window, whether the declared risk budget is feasible, the new forecasts to persist, and expectedLoss(costPointsById)
 * in points, the unit the chooser works in.
 */
export function continuousWindowProtection({model, epsilon, nowMs, weeklyId, windows, modelDataByResource = {}, quotaPoints = 100}) {
  try {
    const prior = priorOf(model);
    dial(epsilon);
    const ids = Object.keys(windows);
    if (!Object.hasOwn(windows, weeklyId) || ids.length > 2) return {problem: 'demand_model_coupling_unknown'};
    if (windows[weeklyId]?.kind !== 'weekly') return {problem: 'demand_model_coupling_unknown'};
    const shortId = ids.find(id => id !== weeklyId) ?? null;
    if (shortId !== null && windows[shortId].kind !== 'short') return {problem: 'demand_model_coupling_unknown'};
    const data = id => modelDataByResource[id] ?? {};
    const weekly = windows[weeklyId];
    // The risk ledger is rebuilt from the persisted issuance rows, so it survives a restart. A caller-supplied index,
    // when present, must name the next issuance.
    const ledgerState = ledgerStateFromRows({epsilon, rows: data(weeklyId).forecasts ?? []});
    if (data(weeklyId).updateIndex !== undefined) checkUpdateIndex(ledgerState.issuedCount, data(weeklyId).updateIndex);
    const updateIndex = ledgerState.issuedCount + 1;

    const originAtMs = data(weeklyId).originAtMs ?? nowMs;
    const initialOwnerUsedMicro = data(weeklyId).initialOwnerUsedMicro ?? weekly.ownerUsedMicro;
    const usageSinceOriginMicro = weekly.ownerUsedMicro - initialOwnerUsedMicro;
    if (usageSinceOriginMicro < 0) return {problem: 'demand_model_exact_usage_required'};
    // Every window's latest issuance caps nothing now (loans are fresh), but its record must be a finite reserve and
    // consistent with that window's current owner usage. Both windows bind, so a corrupt short record fails closed too:
    // a non-finite reserve is demand_model_invalid, and an issue above current usage is demand_model_exact_usage_required.
    for (const id of ids) {
      const latestIssue = (data(id).forecasts ?? []).at(-1);
      if (latestIssue !== undefined) carriedReserve([{reservePoints: latestIssue.reservePoints,
        ownerAtIssue: latestIssue.ownerAtIssue}], windows[id].ownerUsedMicro / MICRO);
    }
    // The coupling converts weekly work into short points by the ratio of the two windows' conversions. A window with no
    // measured conversion (native-window mode) has no ratio. The honest substitute is to decouple: protect the weekly window
    // alone and lend the short window's remaining points, so the live meter guard on both windows stops the job at whichever
    // allowance runs out first. The coupled model's short term was a unit conversion of the weekly loan, never an owner reserve.
    const decoupled = shortId !== null && !(windows[shortId].pointsPerUsdMicro > 0 && weekly.pointsPerUsdMicro > 0);
    const shortPerWeekly = shortId === null || decoupled ? null : windows[shortId].pointsPerUsdMicro / weekly.pointsPerUsdMicro;
    const protection = continuousProtection({model, epsilon, nowMs, ledgerState, quotaPoints,
      weekly: {remainingPoints: weekly.remainingMicro / MICRO, resetAtMs: weekly.resetAtMs, originAtMs,
        ownerUsedSinceOriginMicro: usageSinceOriginMicro, uncertaintyMicro: weekly.uncertaintyMicro ?? 0},
      short: shortId === null || decoupled ? null : {remainingPoints: windows[shortId].remainingMicro / MICRO,
        resetAtMs: windows[shortId].resetAtMs, shortPerWeekly}});

    // The loan is the fresh chance-constrained loan of this issuance and nothing else (binding carry rule). R is net of
    // every committed hold, so loans already made in this window are counted once, and no earlier vintage caps it.
    // The latest vintage's reserve is an identity: remaining minus loans tracks it 1:1 as the owner uses the window.
    // The weekly reserve is held in whole micro-points, rounded up, and the loan is what remains (dot review r2 P2).
    // Rounding up keeps the chance constraint, since harm falls as the reserve rises. A positive reserve is at least one
    // micro-point, so a tiny band near reset cannot round to no reserve. Feasibility is decided at the point level; the cap
    // at the window only absorbs float error when the reserve is the whole window.
    const feasible = protection.predictiveFeasible;
    const reserveWeeklyMicro = feasible
      ? Math.min(weekly.remainingMicro, Math.max(1, Math.ceil(protection.reservePoints.weekly * MICRO)))
      : weekly.remainingMicro;
    const lendMicro = {[weeklyId]: weekly.remainingMicro - reserveWeeklyMicro};
    if (shortId !== null) lendMicro[shortId] = decoupled ? (feasible ? windows[shortId].remainingMicro : 0)
      : Math.min(Math.floor(shortPerWeekly * lendMicro[weeklyId]), windows[shortId].remainingMicro);
    const reservesMicro = Object.fromEntries(ids.map(id => [id, windows[id].remainingMicro - lendMicro[id]]));
    // A request above the remaining window is not a feasible loan, but its expected loss is still reported: at the whole
    // remaining window, which is the largest loan the window can carry. Without the clamp, a large request would throw.
    const weeklyRemainingPoints = weekly.remainingMicro / MICRO;
    const expectedLoss = costPointsById => protection.harm(lossInputs(costPointsById));
    const lossInputs = costPointsById => {
      if (shortId === null || decoupled) return {weekly:Math.min(costPointsById[weeklyId], weeklyRemainingPoints)};
      const cap = Math.min(windows[shortId].remainingMicro / MICRO / shortPerWeekly, weeklyRemainingPoints);
      const work = Math.min(Math.max(costPointsById[weeklyId], costPointsById[shortId] / shortPerWeekly), cap);
      return {weekly:work, short:work * shortPerWeekly};
    };
    expectedLoss.compare = (left, right) => protection.compareHarm(lossInputs(left), lossInputs(right));
    const priorState = {version: prior.version, alpha0: prior.alpha0, b0: prior.b0, K: prior.K};
    const forecasts = feasible ? Object.fromEntries(ids.map(id => [id, {
      modelId: model.id, provenance: model.provenance, priorState,
      updateIndex, originAtMs: data(id).originAtMs ?? nowMs,
      initialCapacityPoints: Math.max(1, Math.ceil(windows[id].remainingMicro / MICRO)),
      initialOwnerUsedMicro: data(id).initialOwnerUsedMicro ?? windows[id].ownerUsedMicro,
      ownerAtIssue: windows[id].ownerUsedMicro / MICRO, reservePoints: reservesMicro[id] / MICRO,
      markBound: 1, riskAlpha: protection.eta,
    }])) : null;
    return {modelId: model.id, modelLabel: `${model.label} Provenance: ${model.provenance}`, provenance: model.provenance,
      eta: protection.eta, predictiveFeasible: feasible, lendMicro, reservesMicro, forecasts, expectedLoss};
  } catch (error) {
    return {problem: problemOf(error)};
  }
}

/**
 * No-op hook for the regularity estimator (research REVIEW-regularity-K-muse). The estimator is not yet derived, so this returns
 * the declared default and never infers K from observations. Keep the signature when the estimator lands.
 */
export function estimateRegularity(observations) {
  void observations;
  return {K: 1, source: 'default'};
}

/**
 * Conjugate pooled update over n weeks of exact history at one common rate (paper 06 section 9; research 08 section 8):
 * alpha = alpha0 + sum K * exposureWeeks and b = b0 + sum usagePoints. It is valid only while the rate is common across
 * the weeks. A drifting rate needs the hierarchical Gamma-Gamma model, which is not ported in v1.
 */
export function pooledPosterior(prior, weeks, quotaPoints = 100) {
  const eff = effectivePrior(prior, quotaPoints);
  let alpha = eff.alpha0, b = eff.b0;
  for (const {exposureWeeks, usagePoints} of weeks) {
    nonNegative(exposureWeeks, 'exposureWeeks');
    nonNegative(usagePoints, 'usagePoints');
    if (exposureWeeks === 0 && usagePoints > 0) throw new RangeError('impossible exact Gamma observation: usage over zero exposure');
    if (exposureWeeks > 0 && usagePoints === 0) throw new RangeError('impossible exact Gamma observation: zero usage over positive exposure');
    alpha += eff.K * exposureWeeks;
    b += usagePoints;
  }
  return {alpha, b, K: eff.K};
}
