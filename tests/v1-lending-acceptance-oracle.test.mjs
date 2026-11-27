import './helpers/no-browser.mjs';
// Acceptance oracle for the continuous lending kernel: research acceptance-fixtures.json at c442f81 (28 cases), copied into
// tests/fixtures/lending-continuous/ with the tolerances the spec states. Eight cases call a named kernel function and
// compare every expected field. Three cases must throw. The other seventeen are the spec's integration witnesses (replay,
// settlement, admission sequence, native guard, explanations). They need the product-path harness the spec marks NOT
// RUN, so they are reported as todo here and never counted as passed.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import * as K from '../lib/v1/lending-continuous.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures/lending-continuous/acceptance-fixtures.json'), 'utf8'));
const SCALAR = {abs: fixtures.tolerances.scalarAbsolute, rel: fixtures.tolerances.scalarRelative};
const NESTED = {abs: fixtures.tolerances.nestedAbsolute, rel: 1e-9};

function compare(path, actual, expected, tol) {
  if (typeof expected === 'number') {
    assert.equal(typeof actual, 'number', `${path}: not a number`);
    assert.ok(Math.abs(actual - expected) <= tol.abs + tol.rel * Math.abs(expected), `${path}: ${actual} vs ${expected}`);
  } else if (expected !== null && typeof expected === 'object') {
    for (const key of Object.keys(expected)) compare(`${path}.${key}`, actual?.[key], expected[key], tol);
  } else {
    assert.equal(actual, expected, path);
  }
}

const kernelCases = fixtures.cases.filter(c => c.kind === 'continuous-function');
const errorCases = fixtures.cases.filter(c => c.kind === 'continuous-error');
const integrationCases = fixtures.cases.filter(c => !['continuous-function', 'continuous-error'].includes(c.kind));

test('acceptance fixtures are the spec\'s 28 cases', () => {
  assert.equal(fixtures.schemaVersion, 1);
  assert.equal(fixtures.cases.length, 28);
  assert.equal(kernelCases.length, 8);
  assert.equal(errorCases.length, 3);
  assert.equal(integrationCases.length, 17);
});

for (const c of kernelCases) {
  test(`oracle ${c.id}: ${c.function} matches the pinned kernel output`, () => {
    assert.equal(typeof K[c.function], 'function', `kernel exports ${c.function}`);
    const actual = K[c.function](...c.args);
    // Scalar tolerance for the closed-form functions, nested quadrature tolerance for the joint ones.
    const tol = /nested/i.test(c.function) ? NESTED : SCALAR;
    compare(c.id, actual, c.expected, tol);
  });
}

for (const c of errorCases) {
  test(`oracle ${c.id}: the kernel refuses the input rather than returning a value`, () => {
    assert.throws(() => K[c.function](...c.args));
  });
}

for (const c of integrationCases) {
  test(`oracle ${c.id} (${c.kind}): NOT RUN, needs the product-path harness`, {todo: 'NOT RUN: acceptance-continuous.md marks this stage as requiring a production adapter and replay harness'}, () => {});
}
