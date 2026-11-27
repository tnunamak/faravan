import './helpers/no-browser.mjs';
// Anytime risk ledger for the M1 allocator (paper 06 section 6, revised): per-issuance budgets, the latest-vintage carry,
// frequentist issuance. The dial is epsilon, the harm-probability cap (binding design, 2026-10-23). lambda is not used.
// Issuance n is the 1-based ordinal (the persisted update_index), and its Bayesian budget is epsilon/[n(n+1)]: the first
// issuance spends epsilon/2 (research 08-default-prior.md section 3). Frequentist budgets follow riskBudget (research aef1cf5).
import test from 'node:test';
import assert from 'node:assert/strict';
import {gammaUpper} from '../lib/v1/lending-continuous.mjs';
import {bayesUpdateBudget, carriedReserve, checkUpdateIndex, createLedgerState, frequentistIssue, issuanceTarget,
  ledgerStateFromRows, recordIssuance, spentBudget} from '../lib/v1/lending-risk-ledger.mjs';

const near = (a, b, tol = 1e-12) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);

test('Bayesian budget for issuance n is epsilon/[n(n+1)]; the first issuance spends epsilon/2', () => {
  near(bayesUpdateBudget({epsilon: 0.1, updateIndex: 1}), 0.05);
  near(bayesUpdateBudget({epsilon: 0.25, updateIndex: 1}), 0.125);
  near(bayesUpdateBudget({epsilon: 0.5, updateIndex: 2}), 0.5 / 6);
  assert.throws(() => bayesUpdateBudget({epsilon: 0.3, updateIndex: 1}), /epsilon/);
});

test('spent budget telescopes: n issuances spend epsilon n/(n+1), below epsilon for every n', () => {
  near(spentBudget(1000, 0.1), 0.1 * 1000 / 1001, 1e-12);
  assert.ok(spentBudget(1000, 0.1) < 0.1);
  assert.equal(spentBudget(0, 0.1), 0);
  // The sum of the per-issuance budgets it telescopes from.
  let sum = 0;
  for (let n = 1; n <= 25; n++) sum += bayesUpdateBudget({epsilon: 0.25, updateIndex: n});
  near(sum, spentBudget(25, 0.25), 1e-12);
});

test('persisted update indices run 1, 2, 3 with no gap or repeat, so n never restarts', () => {
  assert.equal(checkUpdateIndex(0, 1), 1);
  assert.equal(checkUpdateIndex(2, 3), 3);
  assert.throws(() => checkUpdateIndex(2, 4), /next issued index/);
  assert.throws(() => checkUpdateIndex(2, 2), /next issued index/);
  assert.throws(() => checkUpdateIndex(-1, 1), /issued count/);
});

test('carry is latest vintage only: the last issue loses owner usage 1:1, earlier vintages are ignored, none is unbounded', () => {
  assert.equal(carriedReserve([], 25), Infinity);
  assert.equal(carriedReserve([{reservePoints: 60, ownerAtIssue: 10}], 25), 45);
  assert.equal(carriedReserve([{reservePoints: 60, ownerAtIssue: 10}], 80), 0);
  // A stale, tighter vintage must not bind. Under the minimum over all issues this would be 0 and would lend everything.
  assert.equal(carriedReserve([{reservePoints: 10, ownerAtIssue: 0}, {reservePoints: 60, ownerAtIssue: 30}], 40), 50);
  assert.throws(() => carriedReserve([{reservePoints: 60, ownerAtIssue: 30}], 25), /nonmonotone/);
});

test('frequentist issuance has no finite reserve at time zero, since the rate lower bound is zero', () => {
  const zero = frequentistIssue({alpha0: 2, b0: 90, exposure: 0, usagePoints: 0, k: 1, epsilon: 0.25, j: 1});
  near(zero.delta, 0.0625);
  near(zero.eta, 0.25 * 0.5 / 6);
  assert.equal(zero.betaL, 0);
  assert.equal(zero.reserve, Infinity);
});

test('frequentist reserve is the exact Gamma upper quantile at eta; the Chernoff form is only a looser cross-check', () => {
  const issued = frequentistIssue({alpha0: 2, b0: 90, exposure: 1, usagePoints: 10, k: 1, epsilon: 0.25, j: 1});
  assert.ok(issued.betaL > 0 && issued.betaL < 1 / 10, String(issued.betaL));
  // k = 1: Gamma(1, betaL) is exponential, so the exact upper quantile at eta is -log(eta)/betaL.
  near(issued.reserve, -Math.log(issued.eta) / issued.betaL, 1e-12 * issued.reserve);
  // Cross-check: the Chernoff form (1 + sqrt(2z) + z)/betaL is a valid upper bound, so the exact reserve is never larger.
  const chernoff = gammaUpper(1, issued.betaL, issued.eta);
  assert.ok(issued.reserve <= chernoff * (1 + 1e-12), `${issued.reserve} > ${chernoff}`);
  assert.throws(() => frequentistIssue({alpha0: 2, b0: 90, exposure: 1, usagePoints: 0, k: 1, epsilon: 0.25, j: 1}),
    /zero exact usage/);
});

test('issuanceTarget reads its level from the ledger state: epsilon/2, then epsilon/6, then epsilon/12', () => {
  let state = createLedgerState({epsilon: 0.5, targets: []});
  near(issuanceTarget(state, null), 0.25);
  state = recordIssuance(state, issuanceTarget(state, null));
  near(issuanceTarget(state, null), 0.5 / 6);
  state = recordIssuance(state, issuanceTarget(state, null));
  near(issuanceTarget(state, null), 0.5 / 12);
});

test('the ledger state survives a restart: rebuilt from JSON-persisted rows it equals the sequential state', () => {
  let state = createLedgerState({epsilon: 0.25, targets: []});
  const rows = [];
  for (let n = 1; n <= 3; n++) {
    const target = issuanceTarget(state, null);
    state = recordIssuance(state, target);
    rows.push({updateIndex: n, riskAlpha: target});
  }
  const restored = ledgerStateFromRows({epsilon: 0.25, rows: JSON.parse(JSON.stringify(rows))});
  assert.deepEqual(restored, state);
  near(issuanceTarget(restored, null), 0.25 / 20);
});

test('a gap or repeat in persisted issuance indices is refused, and so is a mix of indexed and legacy rows', () => {
  assert.throws(() => ledgerStateFromRows({epsilon: 0.25, rows: [{updateIndex: 1, riskAlpha: 0.125},
    {updateIndex: 3, riskAlpha: 0.04}]}), /next issued index/);
  assert.throws(() => ledgerStateFromRows({epsilon: 0.25, rows: [{updateIndex: 1, riskAlpha: 0.125},
    {ownerAtIssue: 0, reservePoints: 5}]}), /index and a target/);
});

test('legacy count-only rows keep the count and the next level; their targets stay unknown', () => {
  const state = ledgerStateFromRows({epsilon: 0.25, rows: [{ownerAtIssue: 0, reservePoints: 5}]});
  assert.equal(state.issuedCount, 1);
  assert.equal(state.targets, null);
  near(issuanceTarget(state, null), 0.25 / 6);
});
