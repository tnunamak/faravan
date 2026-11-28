import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';


import {compareExpectedLoss, compareExpectedLosses} from '../lib/v1/lending-continuous-model.mjs';

test('P13: local rounding scratch preserves IEEE-754 boundary behavior and deterministic loss comparisons', async () => {
  // Exercise the exact private helpers without adding a production debug/export API.
  const source = fs.readFileSync(new URL('../lib/v1/lending-continuous-model.mjs', import.meta.url), 'utf8');
  const isolated = source.slice(source.indexOf('function nextUp('), source.indexOf('function monotonePanel('));
  const rounding = await import('data:text/javascript,' + encodeURIComponent(
    'const roundingView = new DataView(new ArrayBuffer(8));\n' + isolated + '\nexport {nextUp, nextDown};'));
  const reference = (value, up) => {
    if (Number.isNaN(value) || value === (up ? Infinity : -Infinity)) return value;
    if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    view.setBigUint64(0, up ? (value > 0 ? bits + 1n : bits - 1n) : (value > 0 ? bits - 1n : bits + 1n));
    return view.getFloat64(0);
  };
  const values = [NaN, Infinity, -Infinity, 0, -0, Number.MIN_VALUE, -Number.MIN_VALUE,
    Number.MAX_VALUE, -Number.MAX_VALUE, Number.EPSILON, -Number.EPSILON, 1, -1,
    2 ** -1022, -(2 ** -1022), Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
  for (let exponent = -1074; exponent <= 1023; exponent++) {
    values.push(2 ** exponent, -(2 ** exponent));
  }
  for (const value of values) {
    assert.ok(Object.is(rounding.nextUp(value), reference(value, true)));
    assert.ok(Object.is(rounding.nextDown(value), reference(value, false)));
  }
  assert.equal(compareExpectedLoss(() => 0, 1, 0.1).relation, 'below');
  assert.equal(compareExpectedLoss(() => 1, 1, 0.9).relation, 'above');
  assert.equal(compareExpectedLosses(x => x / 2, 0.5, 1), -1);
  assert.equal(compareExpectedLosses(x => x / 2, 1, 0.5), 1);
  assert.equal(compareExpectedLosses(x => x / 2, 1, 1), 0);
});

