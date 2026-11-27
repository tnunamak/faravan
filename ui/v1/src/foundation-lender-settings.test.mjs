import test from 'node:test';
import assert from 'node:assert/strict';
import { lenderLimitsSaveBody } from './settings-model.mjs';

// Conservative assumption: already-validated limits are opaque at this boundary.
// These fixtures do not define an account or strategy DTO.
test('conservative assembly preserves opaque strategy values and explicit false consent', () => {
  for (const strategy of ['ask', 'fixed_share', 'custom', 'future-strategy']) {
    const policy = Object.freeze({ strategy, providerConsent: Object.freeze({ codex: false }) });
    const limits = Object.freeze({ lendingPolicy: policy, dailyJobs: 0 });
    const result = lenderLimitsSaveBody(limits, null, 7);
    assert.deepEqual(result, { lendingPolicy: policy, dailyJobs: 0, schedule: null, version: 7 });
    assert.equal(result.lendingPolicy, policy);
    assert.notEqual(result, limits);
    assert.equal(Object.hasOwn(result, 'enabled'), false);
    assert.equal(Object.hasOwn(result, 'effort'), false);
  }
});

test('conservative assembly retains the supplied edit revision rather than inventing a retry revision', () => {
  const limits = Object.freeze({ dailyJobs: 2 });
  const first = lenderLimitsSaveBody(limits, null, 3);
  const later = lenderLimitsSaveBody(limits, null, 4);
  assert.equal(first.version, 3);
  assert.equal(later.version, 4);
  assert.equal(Object.hasOwn(limits, 'version'), false);
  assert.deepEqual(lenderLimitsSaveBody(limits, null, 3), first);
});

test('conservative assembly preserves opaque order without adding filtering, enablement or effort', () => {
  const ordered = Object.freeze(['second', 'first']);
  const limits = Object.freeze({ opaqueOrder: ordered });
  const schedule = Object.freeze({ days: Object.freeze([5, 1]) });
  const result = lenderLimitsSaveBody(limits, schedule, 9);
  assert.deepEqual(result, { opaqueOrder: ['second', 'first'], schedule: { days: [5, 1] }, version: 9 });
  assert.equal(result.opaqueOrder, ordered);
  assert.equal(result.schedule, schedule);
  assert.deepEqual(lenderLimitsSaveBody({}, null, 9), { schedule: null, version: 9 });
});

test('explicit schedule and edit revision override stale fields without mutating validated limits', () => {
  const limits = Object.freeze({ schedule: Object.freeze({ old: true }), version: 1, dailyMinutes: 0 });
  assert.deepEqual(lenderLimitsSaveBody(limits, null, 8), { schedule: null, version: 8, dailyMinutes: 0 });
  assert.deepEqual(limits, { schedule: { old: true }, version: 1, dailyMinutes: 0 });
});
