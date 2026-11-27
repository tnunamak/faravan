import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateEffects, createCandidateRegistry} from '../lib/v1/lender-pace50.mjs';

// The cessation backstop must leave room to stop before the earliest window reset: the reset less the stop bound and the uncertainty.
test('the cessation backstop fires a stop bound and an uncertainty before the earliest reset', (t) => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const registry = createCandidateRegistry();
  const requests = [];
  registry.request = (attemptId, reason) => requests.push([attemptId, reason]);
  const effects = candidateEffects({registry, now: () => 0});
  effects.arm_cessation_deadline({attempt_id: 'attempt-a', resource_id: 'weekly', deadline_at: 100000,
    stop_bound_ms: 10000, uncertainty_ms: 2000});
  t.mock.timers.tick(87999);
  assert.deepEqual(requests, [], 'no backstop before the reset less the stop bound and the uncertainty');
  t.mock.timers.tick(1);
  assert.deepEqual(requests, [['attempt-a', 'cessation_deadline']], 'the backstop fires at 88000 ms, not at the reset');
});
