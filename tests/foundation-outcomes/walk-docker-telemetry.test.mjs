import assert from 'node:assert/strict';
import test from 'node:test';
import { createWalkProductPort } from '../foundation-walk/product-port.mjs';

// Conservative partial coverage: the existing app port must stop a cancelled
// W11/W12 walk before dispatch, and require finite polling. This does NOT
// implement or qualify Docker enrollment, telemetry persistence or cleanup.
// Still depends on fv-outcome-walk-cleanup-integration-1114 and registered
// app-operation schemas, which are not defined by product-port's generic API.
test('partial W11/W12 boundary: pre-cancelled wait preserves reason without app effects', async () => {
  let calls = 0, sleeps = 0;
  const port = createWalkProductPort({
    transport: async () => { calls++; throw new Error('must not dispatch'); },
    clock: { sleep: async () => { sleeps++; } },
  });
  const controller = new AbortController();
  const reason = new Error('synthetic walk cancellation');
  controller.abort(reason);
  await assert.rejects(port.wait({}, { maxPolls: 1, pollMs: 0, signal: controller.signal }), e => e === reason);
  assert.equal(calls, 0);
  assert.equal(sleeps, 0);
});

test('partial W11/W12 boundary: invalid poll budgets never launch app work or timers', async () => {
  let calls = 0, sleeps = 0;
  const port = createWalkProductPort({
    transport: async () => { calls++; },
    clock: { sleep: async () => { sleeps++; } },
  });
  for (const options of [
    {}, { maxPolls: 0, pollMs: 0 }, { maxPolls: 1001, pollMs: 0 },
    { maxPolls: 1.5, pollMs: 0 }, { maxPolls: 1, pollMs: -1 },
    { maxPolls: 1, pollMs: Infinity }, { maxPolls: 1, pollMs: 300001 },
  ]) await assert.rejects(port.wait({}, options), { code: 'invalid_poll_budget' });
  assert.equal(calls, 0);
  assert.equal(sleeps, 0);
});

test('partial W11/W12 boundary: missing injected clock cannot fall back to real timers', async () => {
  let calls = 0;
  const port = createWalkProductPort({ transport: async () => { calls++; } });
  await assert.rejects(port.wait({}, { maxPolls: 1, pollMs: 0 }), { code: 'test_clock_required' });
  assert.equal(calls, 0);
});
