import test from 'node:test';
import assert from 'node:assert/strict';
import { replayPolicy } from '../foundation-lending/capture-policy.mjs';

// Synthetic cases and evaluator only; this is not historical-capture evidence.
const baseline = () => ({
  schemaVersion: 1, sourceSha: 'historical-synthetic-revision',
  cases: [{state: 'observed', rawInput: {value: 2}, rawOutput: {value: 4},
    normalizedInput: {value: 3}, normalizedOutput: {value: 6}}],
});

test('synthetic replay evaluates stored inputs without claiming historical capture', () => {
  const saved = baseline(), before = structuredClone(saved), seen = [];
  const replay = replayPolicy(saved, input => {seen.push(input.value); return {value: input.value * 2};});
  assert.equal(replay.kind, 'current-evaluator-replay');
  assert.equal(replay.baselineSourceSha, saved.sourceSha);
  assert.equal(Object.hasOwn(replay, 'sourceSha'), false);
  assert.deepEqual(seen, [2, 3]);
  assert.deepEqual(replay.cases, saved.cases);
  assert.deepEqual(saved, before);
});

test('synthetic changed evaluator fails complete preservation equality', () => {
  const saved = baseline();
  const replay = replayPolicy(saved, input => ({value: input.value * 2 + 1}));
  assert.throws(() => assert.deepEqual(replay.cases, saved.cases), assert.AssertionError);
});

test('synthetic mutating evaluator and returned values cannot modify stored records', () => {
  const saved = baseline(), before = structuredClone(saved);
  const replay = replayPolicy(saved, input => {input.value = 99; return input;});
  replay.cases[0].rawInput.value = 55;
  replay.cases[0].rawOutput.value = 56;
  assert.deepEqual(saved, before);
  assert.throws(() => replayPolicy(saved, input => {input.value = 0; throw new Error('synthetic');}), /synthetic/);
  assert.deepEqual(saved, before);
});
