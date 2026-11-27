// Anytime risk ledger for the M1 allocator (paper 06, section 6): per-update budgets, carried forecasts and
// frequentist issuance. Pure: no clock, I/O or persistence. The caller persists every issued budget before it
// authorizes a reserve, and a process restart never restarts the update index j.
// Units: budgets are probabilities. Reserves and owner usage must share one unit; the decision layer uses micro-points.
import {rateLower} from './lending-continuous.mjs';
import {gammaUpperQuantile} from './lending-gamma-quantile.mjs';

// The one dial is the harm-probability cap epsilon (binding design, 2026-10-23). Its three positions are product
// policy in lending-objective.mjs PROTECTION_POSITIONS. lambda = 1/epsilon is an interpretation, not an objective.
const DIAL_EPSILONS = Object.freeze([0.1, 0.25, 0.5]);

const dial = epsilon => {
  if (!DIAL_EPSILONS.includes(epsilon)) throw new TypeError('epsilon must be 0.10, 0.25 or 0.50');
  return epsilon;
};
const updateIndex = j => {
  if (!Number.isSafeInteger(j) || j < 1) throw new RangeError('update index must be a positive integer');
  return j;
};

/**
 * Bayesian budget for issuance n (1-based ordinal): eta_n = epsilon/[n(n+1)], which is the declared scheme's
 * epsilon/[(j+1)(j+2)] at index j = n-1 (research 08-default-prior.md section 3: every origin row uses eta0 = epsilon/2).
 * The first issuance of a window episode spends epsilon/2. The ordinal is 1-based because the persisted record
 * requires update_index >= 1. Each issuance's chance constraint is at its own budget.
 */
export function bayesUpdateBudget({epsilon, updateIndex: n}) {
  dial(epsilon);
  updateIndex(n);
  return epsilon / (n * (n + 1));
}

/**
 * Total budget after n issuances: the sum of epsilon/[k(k+1)] for k = 1..n, which telescopes to epsilon n/(n+1).
 * It stays below epsilon for every n and approaches it only as issuances accumulate.
 */
export function spentBudget(n, epsilon) {
  dial(epsilon);
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('update count must be a nonnegative integer');
  return epsilon * n / (n + 1);
}

/**
 * The persisted index must run 1, 2, 3 with no gap or repeat: the next issued index is issuedCount + 1.
 * A restart must not restart j, so callers pass the durable count, not a per-process counter.
 */
export function checkUpdateIndex(issuedCount, index) {
  if (!Number.isSafeInteger(issuedCount) || issuedCount < 0) throw new RangeError('issued count must be a nonnegative integer');
  if (index !== issuedCount + 1) throw new RangeError(`next issued index is ${issuedCount + 1}, not ${index}`);
  return index;
}

/**
 * Carried reserve at the current owner usage, from the LATEST issuance only (binding carry rule, research 4f816a9 and
 * REVIEW-carry-rule-muse). That reserve loses the owner usage since its issue, 1:1, floored at zero. Earlier vintages
 * are ignored: taking the minimum over all issues (paper 06 section 6 as written) lends everything to an owner whose
 * stale reserve has been used up. The issues array is in issuance order, so the last entry is the latest. With no
 * issues there is no bound. Usage must never decrease, so an issue with more usage than now is refused.
 */
export function carriedReserve(issues, usageNow) {
  if (!Array.isArray(issues)) throw new TypeError('issues must be an array');
  if (!Number.isFinite(usageNow) || usageNow < 0) throw new RangeError('owner usage must be a finite nonnegative number');
  if (issues.length === 0) return Infinity;
  const {reservePoints, ownerAtIssue} = issues[issues.length - 1];
  if (!Number.isFinite(reservePoints) || reservePoints < 0) throw new RangeError('issued reserve must be finite and nonnegative');
  if (!Number.isFinite(ownerAtIssue) || ownerAtIssue < 0) throw new RangeError('owner usage at issue must be finite and nonnegative');
  if (ownerAtIssue > usageNow) throw new RangeError('owner usage is nonmonotone: an issue recorded more usage than now');
  return Math.max(0, reservePoints - (usageNow - ownerAtIssue));
}

/**
 * Frequentist issuance for one resource-horizon pair (paper 06, section 6). Budgets are delta = epsilon w_h / 2 for the
 * confidence sequence and eta_j = epsilon w_h / [(j+1)(j+2)] for the forecast, with the default indexing weight
 * w_h = 1/[h(h+1)]. The rate lower bound comes from the mixture confidence sequence at delta, so with no exact usage
 * it is zero and the reserve is unbounded, not a fabricated finite value.
 * The reserve is the exact upper quantile of Gamma(k, betaL) at eta, not the looser Chernoff form (kept in
 * lending-continuous.mjs as gammaUpper, a cross-check only).
 */
export function frequentistIssue({alpha0, b0, exposure, usagePoints, k, epsilon, j, h = 1}) {
  dial(epsilon);
  updateIndex(j);
  if (!Number.isSafeInteger(h) || h < 1) throw new RangeError('horizon index must be a positive integer');
  if (exposure > 0 && usagePoints === 0) throw new RangeError('zero exact usage over positive exposure is refused');
  // riskBudget (research aef1cf5): confidence budget epsilon*w/2 at index 0, prediction budget epsilon*w/((j+1)(j+2)).
  const w = 1 / (h * (h + 1));
  const delta = epsilon * w / 2;
  const eta = epsilon * w / ((j + 1) * (j + 2));
  const betaL = rateLower({exposure, usage: usagePoints, alpha: alpha0, b: b0, delta});
  return {delta, eta, betaL, reserve: gammaUpperQuantile(k, betaL, eta)};
}

// ---- Issuance level behind one function. The replacement rule lands in issuanceTarget; callers do not change. ----
// The current rule is the paper's schedule: eta_n = epsilon/[n(n+1)], n the 1-based issuance ordinal (research
// 08-default-prior.md section 3: the first issuance spends epsilon/2). The conditional error-spending rule (research
// dec25d9, REVIEW-conditional-error-muse.md) will replace the body of issuanceTarget, and the state below is what it reads.
export const LEDGER_RULE = 'schedule-v1';

/**
 * The persisted risk-ledger state of one window episode: JSON-safe, frozen, and rebuilt from the persisted issuance rows
 * after a restart (ledgerStateFromRows). targets are the levels already spent, or null when a legacy row lacks them.
 */
export function createLedgerState({epsilon, issuedCount = 0, targets = null} = {}) {
  dial(epsilon);
  if (!Number.isSafeInteger(issuedCount) || issuedCount < 0) throw new RangeError('issued count must be a nonnegative integer');
  if (targets !== null && (!Array.isArray(targets) || targets.length !== issuedCount || targets.some(t => !(t > 0 && t < 1))))
    throw new RangeError('issued targets must match the issued count');
  return Object.freeze({schemaVersion: 1, rule: LEDGER_RULE, epsilon, issuedCount,
    targets: targets === null ? null : Object.freeze([...targets])});
}

/** The chance level of the next issuance. `posterior` is what the replacement rule reads; this schedule does not read it. */
export function issuanceTarget(ledgerState, posterior) {
  void posterior;
  if (ledgerState?.rule !== LEDGER_RULE) throw new TypeError('unknown ledger rule');
  return bayesUpdateBudget({epsilon: ledgerState.epsilon, updateIndex: ledgerState.issuedCount + 1});
}

/** The state after one issuance spent `target`. The ordinal advances by one, so the sequence never skips or repeats. */
export function recordIssuance(ledgerState, target) {
  if (!(target > 0 && target < 1)) throw new RangeError('issuance target must be in (0, 1)');
  return createLedgerState({epsilon: ledgerState.epsilon, issuedCount: ledgerState.issuedCount + 1,
    targets: ledgerState.targets === null ? null : [...ledgerState.targets, target]});
}

/**
 * Rebuild the state from the persisted issuance rows, in order. Each row carries updateIndex and riskAlpha, or neither
 * (legacy). A gap or repeat in the index is refused, and so is a mix of both kinds.
 */
export function ledgerStateFromRows({epsilon, rows}) {
  if (!Array.isArray(rows)) throw new TypeError('issuance rows must be an array');
  const indexed = rows.length > 0 && rows.every(r => Number.isSafeInteger(r?.updateIndex) && typeof r?.riskAlpha === 'number');
  if (!indexed && rows.some(r => r?.updateIndex !== undefined || r?.riskAlpha !== undefined))
    throw new TypeError('issuance rows must all carry an index and a target, or none');
  if (indexed) rows.forEach((r, i) => checkUpdateIndex(i, r.updateIndex));
  return createLedgerState({epsilon, issuedCount: rows.length, targets: indexed ? rows.map(r => r.riskAlpha) : null});
}
