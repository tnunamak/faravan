import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {sbxVersionCheck} from '../lib/docker-backend.mjs';

for (const [version, passed] of [
  ['v0.49.1 c5b1abc', false],
  ['v0.50.1', false],
  ['v0.51.0', true],
  ['v0.52.3', true],
  ['v1.0.0', true],
]) {
  test(`Docker Sandboxes minimum: ${version} is ${passed ? 'passed' : 'blocked'}`, () => {
    const check = sbxVersionCheck({code:0, stdout:`sbx version ${version}`, stderr:''});
    assert.equal(check.ok, passed);
    assert.equal(check.status, passed ? 'passed' : 'blocked');
    assert.equal(check.fix, passed ? '' : 'Update Docker Sandboxes to 0.51.0 or newer.');
  });
}

test('blocked versions name the exact Docker Sandboxes update step', () => {
  assert.equal(sbxVersionCheck({code:0, stdout:'sbx version v0.49.1 c5b1abc'}).fix,
    'Update Docker Sandboxes to 0.51.0 or newer.');
});
