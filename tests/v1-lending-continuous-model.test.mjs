import './helpers/no-browser.mjs';
// Default demand model for the M1 allocator: continuous Gamma demand (paper 06 sections 3-8; research 08 section 7).
// Expected values are closed forms, the chance-constraint identity and the declared day-one table, not values read back
// from the implementation. The dial is epsilon, the harm-probability cap (binding design, 2026-10-23). The chance level
// of issuance n is epsilon/[n(n+1)], so the first issuance spends epsilon/2 (paper 06 section 8: eta1 = 1/(2 lambda)).
import test from 'node:test';
import assert from 'node:assert/strict';
import {loss, nestedCdf, survival} from '../lib/v1/lending-continuous.mjs';
import {CONTINUOUS_DEMAND_MODEL, DEFAULT_PRIOR, OPTIMISTIC_DEFAULT_V1, WEEK_MS, continuousLaw, continuousProtection,
  continuousWindowProtection, createContinuousDemandModel, effectivePrior, estimateRegularity, pooledPosterior} from '../lib/v1/lending-continuous-model.mjs';

const NOW = Date.UTC(2026, 9, 23, 12);
const HOUR = 3_600_000;
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
const weekly = ({remainingPoints = 100, resetAtMs = NOW + WEEK_MS, originAtMs = NOW, ownerUsedSinceOriginMicro = 0} = {}) =>
  ({remainingPoints, resetAtMs, originAtMs, ownerUsedSinceOriginMicro});
const HEAVY = createContinuousDemandModel({alpha0: 2, b0: 90});
const LIGHT = createContinuousDemandModel({alpha0: 2, b0: 10});
// The dial positions: Keep more for me, Balanced, Share more.
const DIALS = [0.1, 0.25, 0.5];
// Closed form for a shape-one day-one law (alpha 2, scale b) at chance level eta: R - Q(eta), Q = b(eta^(-1/2) - 1).
const dayOneLoan = (b, eta, R = 100) => R - b * (eta ** -0.5 - 1);

test('the default is the continuous Gamma model with the declared starting assumption optimistic-default-v1', () => {
  assert.equal(CONTINUOUS_DEMAND_MODEL.kind, 'continuous-gamma');
  assert.equal(CONTINUOUS_DEMAND_MODEL.id, 'continuous-gamma-v1');
  assert.equal(DEFAULT_PRIOR, OPTIMISTIC_DEFAULT_V1);
  assert.equal(DEFAULT_PRIOR.version, 'optimistic-default-v1');
  assert.equal(DEFAULT_PRIOR.alpha0, 2);
  near(DEFAULT_PRIOR.b0, 25.920643997366426, 1e-12);
  assert.equal(DEFAULT_PRIOR.K, 1, 'the default never ships a higher regularity');
  assert.equal(DEFAULT_PRIOR.quotaReferencePoints, 100);
  assert.equal(CONTINUOUS_DEMAND_MODEL.prior.version, 'optimistic-default-v1');
  assert.equal(CONTINUOUS_DEMAND_MODEL.prior.K, 1);
  assert.equal(WEEK_MS, 168 * HOUR);
  assert.match(CONTINUOUS_DEMAND_MODEL.provenance, /06-continuous-closed-form/);
  assert.match(CONTINUOUS_DEMAND_MODEL.label, /declared prior/);
});

test('day-one allowances at Q = 100 under optimistic-default-v1 are 10.000000, 52.605991 and 74.079356', () => {
  const allowances = DIALS.map(epsilon => continuousProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon, nowMs: NOW,
    weekly: weekly(), short: null}).loanWeekly);
  near(allowances[0], 10.000000, 5e-7);
  near(allowances[1], 52.605991, 5e-7);
  near(allowances[2], 74.079356, 5e-7);
  // The closed form, independent of the implementation: 100 - b (eta^(-1/2) - 1) at eta = epsilon/2.
  DIALS.forEach((epsilon, i) => near(allowances[i], dayOneLoan(DEFAULT_PRIOR.b0, epsilon / 2), 1e-9));
});

test('review 1024b P2-1: the production default is optimistic-default-v1 and lends on a full 100-point week at epsilon 0.5', () => {
  assert.deepEqual({version: DEFAULT_PRIOR.version, alpha0: DEFAULT_PRIOR.alpha0, b0: DEFAULT_PRIOR.b0, K: DEFAULT_PRIOR.K},
    {version: 'optimistic-default-v1', alpha0: 2, b0: 25.920643997366426, K: 1});
  // A full week at origin: exposure 0, remaining shape 1, owner usage 0. The first issuance (ordinal 1) spends eps/2 = 1/4.
  const full = {remainingPoints: 100, resetAtMs: WEEK_MS, originAtMs: 0, ownerUsedSinceOriginMicro: 0};
  near(continuousProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon: 0.5, nowMs: 0, weekly: full, updateIndex: 1})
    .loanWeekly, 74.079356, 5e-7);
  // The report's figure, 36.12889926067865, is the second issuance (ordinal 2): eta = 0.5/6 = 1/12. The report counted
  // its first issuance as index 1 under the schedule before commit bb60f7cb, which is this same second issuance now.
  near(continuousProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon: 0.5, nowMs: 0, weekly: full, updateIndex: 2})
    .loanWeekly, 36.12889926067865, 5e-7);
});

test('conjugate update: Gamma(alpha0 + exposure, b0 + usage) on the week clock, remaining shape to reset', () => {
  const heavy = createContinuousDemandModel({alpha0: 2, b0: 90}).prior;
  const atOrigin = continuousLaw({prior: heavy, originAtMs: NOW, nowMs: NOW, resetAtMs: NOW + WEEK_MS,
    usedSinceOriginMicro: 0});
  assert.deepEqual([atOrigin.alpha, atOrigin.b, atOrigin.k], [2, 90, 1]);
  const halfWeek = continuousLaw({prior: heavy, originAtMs: NOW - WEEK_MS / 2, nowMs: NOW,
    resetAtMs: NOW + WEEK_MS / 2, usedSinceOriginMicro: 10_000_000});
  near(halfWeek.alpha, 2.5, 1e-12);
  near(halfWeek.b, 100, 1e-12);
  near(halfWeek.k, 0.5, 1e-12);
});

test('exact usage is required: zero usage over positive exposure is refused, never read as zero', () => {
  assert.throws(() => continuousLaw({prior: DEFAULT_PRIOR, originAtMs: NOW - HOUR, nowMs: NOW,
    resetAtMs: NOW + WEEK_MS, usedSinceOriginMicro: 0}), /impossible exact Gamma observation/);
});

test('the regularity K is a model field: b0 scales as 1/K and the prior mean K b0/(alpha0 - 1) stays fixed', () => {
  const meanAt = K => {
    const model = createContinuousDemandModel({alpha0: 2, b0: DEFAULT_PRIOR.b0, K});
    const eff = effectivePrior(model.prior);
    return {b0: eff.b0, mean: eff.K * eff.b0 / (eff.alpha0 - 1)};
  };
  const at1 = meanAt(1);
  near(at1.b0, DEFAULT_PRIOR.b0, 1e-12);
  for (const K of [2, 5]) {
    const at = meanAt(K);
    near(at.b0, DEFAULT_PRIOR.b0 / K, 1e-12);
    near(at.mean, at1.mean, 1e-12);
  }
});

test('K sets the exposure clock A(t) = K t/168: at mid-week the posterior shape and remaining shape scale with K', () => {
  const midWeek = {prior: createContinuousDemandModel({alpha0: 2, b0: 90, K: 2}).prior, originAtMs: NOW,
    nowMs: NOW + WEEK_MS / 2, resetAtMs: NOW + WEEK_MS, usedSinceOriginMicro: 1_000_000};
  // Exact usage is required over positive exposure, so the test records one point of owner usage.
  const k2 = continuousLaw(midWeek);
  near(k2.alpha, 2 + 2 * 0.5, 1e-12);
  near(k2.k, 2 * 0.5, 1e-12);
});

test('the window quota scales the prior: doubling the quota doubles the day-one allowance', () => {
  const at200 = continuousProtection({model: CONTINUOUS_DEMAND_MODEL, epsilon: 0.25, nowMs: NOW, quotaPoints: 200,
    weekly: weekly({remainingPoints: 200}), short: null});
  near(at200.loanWeekly, 2 * 52.605991, 1e-6);
});

test('estimateRegularity is a no-op hook that returns the declared default and never infers K', () => {
  assert.deepEqual(estimateRegularity([]), {K: 1, source: 'default'});
  assert.deepEqual(estimateRegularity([{exposureWeeks: 1, usagePoints: 50}]), {K: 1, source: 'default'});
});

test('the pooled conjugate update over exact weeks equals the sequential posterior at one common rate', () => {
  const pooled = pooledPosterior(DEFAULT_PRIOR, [{exposureWeeks: 0.5, usagePoints: 10}, {exposureWeeks: 1, usagePoints: 20}]);
  near(pooled.alpha, 2 + 1.5, 1e-12);
  near(pooled.b, DEFAULT_PRIOR.b0 + 30, 1e-12);
  assert.throws(() => pooledPosterior(DEFAULT_PRIOR, [{exposureWeeks: 1, usagePoints: 0}]), /zero usage over positive exposure/);
});

test('day-one scalar loans for the light reference at epsilon 0.10/0.25/0.50 match paper section 8', () => {
  const light = DIALS.map(epsilon => continuousProtection({model: LIGHT, epsilon, nowMs: NOW, weekly: weekly(),
    short: null}));
  near(light[0].loanWeekly, 65.278640, 5e-7);
  near(light[1].loanWeekly, 81.715729, 5e-7);
  near(light[2].loanWeekly, 90, 5e-7);
  assert.ok(light.every(r => r.predictiveFeasible));
  const heavy = DIALS.map(epsilon => continuousProtection({model: HEAVY, epsilon, nowMs: NOW, weekly: weekly(),
    short: null}));
  assert.deepEqual(heavy.map(r => r.loanWeekly), [0, 0, 10]);
  assert.deepEqual(heavy.map(r => r.predictiveFeasible), [false, false, true]);
});

test('paper section 8 two-window light reference reproduces the joint loans at epsilon 0.10/0.25/0.50', () => {
  const short = {remainingPoints: 100, resetAtMs: NOW + 5 * HOUR, shortPerWeekly: 158 / 53};
  const expected = [32.1175127348, 33.4724970343, 33.5439047624];
  DIALS.forEach((epsilon, i) => {
    const r = continuousProtection({model: LIGHT, epsilon, nowMs: NOW, weekly: weekly(), short});
    near(r.loanWeekly, expected[i], 1e-8);
    near(r.reservePoints.short, 100 - r.loanWeekly * 158 / 53, 1e-8);
  });
});

test('the joint loan is the chance-constraint root: P(harm(loan)) equals the issuance budget epsilon/2 at every dial', () => {
  // Joint harm: {z < x} = {X > C - x or W > R - x}, with C = 100 / (158/53) work units, R = 100, kShort = 5/168,
  // kLater = 163/168, and the light origin posterior Gamma(2, 10). Each dial's loan must sit exactly on its budget.
  const short = {remainingPoints: 100, resetAtMs: NOW + 5 * HOUR, shortPerWeekly: 158 / 53};
  const C = 100 / (158 / 53), R = 100;
  let previous = -Infinity;
  for (const epsilon of DIALS) {
    const r = continuousProtection({model: LIGHT, epsilon, nowMs: NOW, weekly: weekly(), short});
    assert.equal(r.predictiveFeasible, true);
    const harmProbability = 1 - nestedCdf({short: C - r.loanWeekly, week: R - r.loanWeekly,
      kShort: 5 / 168, kLater: 163 / 168, alpha: 2, b: 10});
    near(harmProbability, epsilon / 2, 1e-7);
    assert.ok(r.loanWeekly > previous, 'protection rises with the dial');
    previous = r.loanWeekly;
  }
});

test('objective loss is the paper S(x) = integral of P(D > s) over [R - x, R], exact to quadrature tolerance', () => {
  const r = continuousProtection({model: HEAVY, epsilon: 0.25, nowMs: NOW, weekly: weekly(), short: null});
  const law = {k: 1, alpha: 2, b: 90};
  for (const x of [0.5, 3, 9]) {
    near(r.harm({weekly: x}), integral(s => survival(s, law), 100 - x, 100), 1e-9);
    near(r.harm({weekly: x}), loss(100, x, law), 1e-12);
  }
  assert.equal(r.harm({weekly: 0}), 0);
});

test('a joint chunk is charged at its binding window: short points over their conversion, weekly points as is', () => {
  const short = {remainingPoints: 100, resetAtMs: NOW + 5 * HOUR, shortPerWeekly: 158 / 53};
  const r = continuousProtection({model: HEAVY, epsilon: 0.5, nowMs: NOW, weekly: weekly(), short});
  near(r.harm({weekly: 0, short: 3 * 158 / 53}), r.harm({weekly: 3}), 1e-12);
  near(r.harm({weekly: 1, short: 3 * 158 / 53}), r.harm({weekly: 3}), 1e-12);
});

test('fail closed: non-finite capacity, expired reset, reversed window order and off-dial epsilon are refused', () => {
  const base = {model: HEAVY, epsilon: 0.25, nowMs: NOW, short: null};
  assert.throws(() => continuousProtection({...base, weekly: weekly({remainingPoints: Number.NaN})}), TypeError);
  assert.throws(() => continuousProtection({...base, weekly: weekly({resetAtMs: NOW})}), /not in the future/);
  assert.throws(() => continuousProtection({...base, weekly: weekly(), short: {remainingPoints: 10,
    resetAtMs: NOW + 2 * WEEK_MS, shortPerWeekly: 1}}), /before the weekly/);
  assert.throws(() => continuousProtection({...base, epsilon: 0.3, weekly: weekly()}), /epsilon/);
});

// Local integral for the test's own loss check, the same adaptive Simpson the implementation mirrors.
function integral(f, a, b, tol = 1e-12) {
  const fa = f(a), fb = f(b), m = (a + b) / 2, fm = f(m), whole = (b - a) * (fa + 4 * fm + fb) / 6;
  const rec = (a, b, fa, fm, fb, old, tol, n) => {
    const m = (a + b) / 2, l = (a + m) / 2, r = (m + b) / 2, fl = f(l), fr = f(r);
    const left = (m - a) * (fa + 4 * fl + fm) / 6, right = (b - m) * (fm + 4 * fr + fb) / 6, d = left + right - old;
    if (Math.abs(d) <= 15 * tol) return left + right + d / 15;
    if (!n) throw new RangeError('quadrature convergence');
    return rec(a, m, fa, fl, fm, left, tol / 2, n - 1) + rec(m, b, fm, fr, fb, right, tol / 2, n - 1);
  };
  return rec(a, b, fa, fm, fb, whole, tol, 24);
}

for (const weeklyId of ['seven_day', 'custom_week']) {
  for (const withShort of [false, true]) {
    const input = () => ({model: CONTINUOUS_DEMAND_MODEL, epsilon: 0.25, nowMs: NOW, weeklyId,
      windows: {
        [weeklyId]: {kind: 'weekly', remainingMicro: 100_000_000, resetAtMs: NOW + WEEK_MS,
          ownerUsedMicro: 0, pointsPerUsdMicro: 1_000_000},
        ...(withShort ? {five_hour: {kind: 'short', remainingMicro: 100_000_000,
          resetAtMs: NOW + 5 * HOUR, ownerUsedMicro: 0, pointsPerUsdMicro: 1_000_000}} : {}),
      }});
    const label = `${weeklyId}, ${withShort ? 'weekly+short' : 'weekly-only'}`;
    test(`continuous adapter weekly kind valid control: ${label}`, () => {
      const result = continuousWindowProtection(input());
      assert.equal(result.problem, undefined);
      assert.equal(result.predictiveFeasible, true);
      assert.ok(result.lendMicro[weeklyId] > 0);
      assert.deepEqual(Object.keys(result.lendMicro), withShort ? [weeklyId, 'five_hour'] : [weeklyId]);
    });
    for (const kind of ['short', undefined, 'unknown']) {
      test(`continuous adapter rejects designated weekly ${kind ?? 'missing'} kind: ${label}`, () => {
        const malformed = input();
        if (kind === undefined) delete malformed.windows[weeklyId].kind;
        else malformed.windows[weeklyId].kind = kind;
        assert.deepEqual(continuousWindowProtection(malformed), {problem: 'demand_model_coupling_unknown'});
      });
    }
  }
}
