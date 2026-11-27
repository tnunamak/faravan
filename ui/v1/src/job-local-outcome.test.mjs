import test from 'node:test';
import assert from 'node:assert/strict';
import {markJobDeleted, isJobDeleted, appliedFrom} from './job-local-outcome.mjs';

const D = 'sha256:' + 'c'.repeat(64), api = {}, other = {};

test('a deleted job stays hidden until the list stops naming it', () => {
  markJobDeleted(api, D);
  assert.equal(isJobDeleted(api, D), true);
  assert.equal(isJobDeleted(api, 'sha256:other'), false);
  assert.equal(isJobDeleted(other, D), false, 'another api object (another sign-in) sees nothing');
});
test('an apply response becomes the applied record the page reads', () => {
  assert.deepEqual(appliedFrom({status: 'applied', branch: 'faravan/x', repo: '/work/site'}), {branch: 'faravan/x', repo: '/work/site'});
  assert.deepEqual(appliedFrom({branch: 'b', repo: '/r', commit: 'abc', at: '2026-10-21T00:00:00Z', status: 'applied'}), {branch: 'b', repo: '/r', commit: 'abc', at: '2026-10-21T00:00:00Z'});
  assert.equal(appliedFrom({status: 'applied'}), null);
  assert.equal(appliedFrom(null), null);
});
