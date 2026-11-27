// Exact upper quantile of Gamma(k, rate beta): the frequentist predictive bound of paper 06, section 6, where the
// budget is spent. Production's Bayesian band is already exact (the beta-prime quantile in lending-continuous.mjs).
// continuous.mjs has only the elementary Chernoff form (gammaUpper), which is a valid but looser bound and is kept
// there as a cross-check.
//
// Q(k, x) = P(Gamma(k, 1) > x) is the regularized upper incomplete gamma. It is evaluated in logs: a power series
// for the lower part when x < k + 1, and Lentz's continued fraction for the upper part otherwise. The quantile is the
// root of the strictly decreasing log Q(k, e^t) = log eta, found by bisection in t = log x.
// Binary64 throughout. Directed rounding and interval enclosures are not implemented (paper 06, section 10).
import {logGamma} from './lending-continuous.mjs';

// Numerical tolerances of the evaluation. They are not model constants.
const TERM_TOLERANCE = 1e-15;     // series and continued-fraction stopping rule
const MAX_TERMS = 100_000;
const TINY = 1e-300;              // Lentz floor against division by zero
const LOG_TOLERANCE = 1e-13;      // bisection width in log x, so relative precision in x of about 1e-13
const MAX_BISECTIONS = 200;
const LOG_MIN_POSITIVE = Math.log(Number.MIN_VALUE);
const LOG_MAX = Math.log(Number.MAX_VALUE);

// log P(a, x) for x < a + 1, from P = e^-x x^a / Gamma(a+1) * sum_n x^n / ((a+1)...(a+n)).
function logLowerSeries(a, x) {
  let term = 1, sum = 1;
  for (let n = 1; n <= MAX_TERMS; n++) {
    term *= x / (a + n);
    sum += term;
    if (term < sum * TERM_TOLERANCE) return -x + a * Math.log(x) + Math.log(sum) - logGamma(a + 1);
  }
  throw new RangeError('gamma series did not converge');
}

// log Q(a, x) for x >= a + 1, by the modified Lentz continued fraction (Numerical Recipes gcf form).
function logUpperContinuedFraction(a, x) {
  let b = x + 1 - a, c = 1 / TINY, d = 1 / b, h = d;
  for (let i = 1; i <= MAX_TERMS; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < TINY) d = TINY;
    c = b + an / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < TERM_TOLERANCE) return -x + a * Math.log(x) - logGamma(a) + Math.log(h);
  }
  throw new RangeError('gamma continued fraction did not converge');
}

/** log Q(a, x) = log P(Gamma(a, 1) > x), for a > 0 and x >= 0. */
export function logUpperGamma(a, x) {
  if (x === 0) return 0;
  if (x < a + 1) return Math.log1p(-Math.exp(logLowerSeries(a, x)));
  return logUpperContinuedFraction(a, x);
}

/**
 * The x with P(Gamma(k, 1) > x) = eta, for k > 0 and 0 < eta < 1. A quantile below the smallest positive double
 * returns 0; a quantile above the largest double throws, never a plausible-looking value.
 */
export function gammaQuantile(k, eta) {
  if (typeof k !== 'number' || !Number.isFinite(k) || k <= 0) throw new RangeError('gamma shape must be a positive finite number');
  if (typeof eta !== 'number' || !(eta > 0 && eta < 1)) throw new RangeError('eta must be in (0, 1)');
  const target = Math.log(eta);
  const stillBelow = t => logUpperGamma(k, Math.exp(t)) >= target;
  if (!stillBelow(LOG_MIN_POSITIVE)) return 0;
  let lo = LOG_MIN_POSITIVE, hi = 0;
  while (stillBelow(hi)) {
    lo = hi;
    hi += 1;
    if (hi > LOG_MAX) throw new RangeError('gamma quantile overflows');
  }
  for (let i = 0; i < MAX_BISECTIONS && hi - lo > LOG_TOLERANCE; i++) {
    const mid = (lo + hi) / 2;
    if (stillBelow(mid)) lo = mid; else hi = mid;
  }
  return Math.exp((lo + hi) / 2);
}

/**
 * Upper bound for Gamma(k, rate beta) at level eta: the exact quantile of Gamma(k, beta). It is the upper
 * quantile of the rate-beta law: P(Gamma(k, beta) > B) = eta. The same argument as the Chernoff form holds: on
 * beta >= betaL, Gamma(k, beta) is stochastically dominated by Gamma(k, betaL). Shape zero is a point mass at
 * zero; zero rate has no finite bound.
 */
export function gammaUpperQuantile(k, beta, eta) {
  if (typeof k !== 'number' || Number.isNaN(k) || k < 0) throw new TypeError('gamma shape must be a nonnegative number');
  if (typeof beta !== 'number' || Number.isNaN(beta) || beta < 0) throw new TypeError('gamma rate must be a nonnegative number');
  if (typeof eta !== 'number' || !(eta > 0 && eta < 1)) throw new RangeError('eta must be in (0, 1)');
  if (k === 0) return 0;
  if (beta === 0) return Infinity;
  const value = gammaQuantile(k, eta) / beta;
  if (!Number.isFinite(value)) throw new RangeError('gamma upper quantile overflows');
  return value;
}
