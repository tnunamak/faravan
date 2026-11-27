import './helpers/no-browser.mjs';
// Exact Gamma upper quantile (paper 06, section 6). Checked against closed forms, an independent Poisson-sum identity
// for integer shapes, a recurrence for non-integer shapes, and a seeded Monte Carlo sample. The Chernoff form in
// continuous.mjs is an upper bound and is checked only as a cross-check.
import test from 'node:test';
import assert from 'node:assert/strict';
import {gammaUpper, logGamma} from '../lib/v1/lending-continuous.mjs';
import {gammaQuantile, gammaUpperQuantile, logUpperGamma} from '../lib/v1/lending-gamma-quantile.mjs';

// Q(k, x) for integer k, from the Poisson sum: e^-x sum_{i<k} x^i / i!. It does not share code with the evaluator.
const poissonUpper = (k, x) => {
  let sum = 0, term = 1;
  for (let i = 0; i < k; i++) {
    if (i > 0) term *= x / i;
    sum += term;
  }
  return Math.exp(-x) * sum;
};

test('shape 1 is exponential: the exact quantile is -log(eta)', () => {
  for (const eta of [0.5, 0.25, 0.125, 0.05, 0.03125, 1e-4]) {
    const x = gammaQuantile(1, eta);
    assert.ok(Math.abs(x - -Math.log(eta)) <= 1e-12 * -Math.log(eta), `${x} != ${-Math.log(eta)} at eta ${eta}`);
  }
});

test('integer shapes satisfy the Poisson-sum identity at the computed quantile', () => {
  for (const k of [2, 3, 5, 10]) {
    for (const eta of [0.5, 0.1, 0.01, 1e-5]) {
      const x = gammaQuantile(k, eta);
      assert.ok(Math.abs(poissonUpper(k, x) - eta) <= 1e-12, `k ${k} eta ${eta}: ${poissonUpper(k, x)} != ${eta}`);
    }
  }
});

test('non-integer shapes satisfy the recurrence Q(k+1, x) - Q(k, x) = x^k e^-x / Gamma(k+1)', () => {
  for (const k of [0.03, 0.5, 2.5]) {
    for (const x of [0.2, 1, 4, 12]) {
      const lhs = Math.exp(logUpperGamma(k + 1, x)) - Math.exp(logUpperGamma(k, x));
      const rhs = Math.exp(k * Math.log(x) - x - logGamma(k + 1));
      assert.ok(Math.abs(lhs - rhs) <= 1e-12 + 1e-12 * rhs, `k ${k} x ${x}: ${lhs} vs ${rhs}`);
    }
  }
});

test('the quantile rises as eta falls, and the exact bound never exceeds the Chernoff upper bound', () => {
  for (const k of [0.03, 0.5, 1, 2.5, 7]) {
    let previous = 0;
    for (const eta of [0.5, 0.25, 0.1, 0.05, 0.01]) {
      const x = gammaQuantile(k, eta);
      assert.ok(x > previous, `k ${k} eta ${eta}: quantile ${x} did not rise above ${previous}`);
      previous = x;
      const z = -Math.log(eta);
      const chernoff = k + Math.sqrt(2 * k * z) + z;
      assert.ok(x <= chernoff * (1 + 1e-12), `k ${k} eta ${eta}: exact ${x} above Chernoff ${chernoff}`);
    }
  }
});

test('independent Monte Carlo check: the empirical exceedance at the quantile matches eta for non-integer shapes', () => {
  // Seeded xorshift32 and Marsaglia-Tsang sampling, independent of the evaluator's code.
  let state = 0x9e3779b9;
  const uniform = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return (state + 0.5) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  const gammaSample = shape => {
    if (shape < 1) return gammaSample(shape + 1) * Math.pow(uniform(), 1 / shape);
    const d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x, v;
      do { x = normal(); v = 1 + c * x; } while (v <= 0);
      v = v * v * v;
      const u = uniform();
      // Marsaglia-Tsang acceptance uses the same normal x that produced v.
      if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) return d * v;
    }
  };
  const n = 200_000;
  for (const shape of [0.5, 2.5]) {
    const samples = Array.from({length: n}, () => gammaSample(shape));
    for (const eta of [0.25, 0.05]) {
      const x = gammaQuantile(shape, eta);
      const exceed = samples.filter(s => s > x).length / n;
      // Binomial standard error at this n is at most 0.0012, so 0.006 is five standard errors.
      assert.ok(Math.abs(exceed - eta) <= 0.006, `shape ${shape} eta ${eta}: empirical ${exceed}`);
    }
  }
});

test('gamma upper quantile for rate beta is the shape quantile divided by beta', () => {
  const x = gammaQuantile(2.5, 0.1);
  assert.ok(Math.abs(gammaUpperQuantile(2.5, 4, 0.1) - x / 4) <= 1e-15 * x);
  assert.equal(gammaUpperQuantile(0, 4, 0.1), 0, 'shape zero is a point mass at zero');
  assert.equal(gammaUpperQuantile(1, 0, 0.1), Infinity, 'zero rate has no finite bound');
  assert.ok(gammaUpperQuantile(1, 2, 0.1) <= gammaUpper(1, 2, 0.1) * (1 + 1e-12), 'Chernoff stays an upper bound');
});

test('fail closed: invalid shape, level or rate is refused; an underflowing quantile is zero, not a guess', () => {
  assert.throws(() => gammaQuantile(-1, 0.5), RangeError);
  assert.throws(() => gammaQuantile(Number.NaN, 0.5), RangeError);
  assert.throws(() => gammaQuantile(1, 0), RangeError);
  assert.throws(() => gammaQuantile(1, 1), RangeError);
  assert.throws(() => gammaUpperQuantile(1, -1, 0.5), TypeError);
  assert.throws(() => gammaUpperQuantile(1, 1, Number.NaN), RangeError);
  assert.equal(gammaQuantile(0.0005, 0.5), 0, 'the quantile is below the smallest positive double');
  assert.ok(gammaQuantile(0.01, 0.5) > 0 && gammaQuantile(0.01, 0.5) < 1e-29);
});
