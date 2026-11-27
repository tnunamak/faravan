import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsage } from '../../lib/v1/account-usage.mjs';

// Synthetic account-layer regression. This does not establish legacy runtime integration.
test('generation rotation cannot shorten fallback throttle backoff; restart retains the deadline', async () => {
  let now = 1000, calls = 0, resolveRead;
  const state = { records: { a: { generation: 1 } } };
  const store = {
    get: id => structuredClone(state.records[id]),
    transaction: async fn => fn(state),
    exclusive: async (_id, fn) => fn(),
    exclusiveUsage: async (_id, fn) => fn(),
  };
  const broker = {
    withAuth: async (_id, fn) => ({ ok: true, value: await fn({ generation: state.records.a.generation }) }),
    refreshAuth: async () => { throw new Error('unexpected refresh'); },
  };
  const adapter = {
    descriptor: { usageKind: 'remote', nativeUnits: [] },
    readUsage: async () => { calls++; return new Promise(resolve => { resolveRead = resolve; }); },
  };
  let reader = createAccountUsage({ accountId: 'a', store, broker, adapter, clock: () => now, running: () => 2 });
  try {
    const first = reader.requestRead({ reason: 'guard' });
    while (!resolveRead) await Promise.resolve();
    state.records.a.generation = 2;
    resolveRead({ kind: 'throttled' });
    const after = await first;
    assert.equal(after.state, 'backoff');
    assert.equal(after.nextReadAtMs, 301000);
    await reader.close();
    reader = createAccountUsage({ accountId: 'a', store, broker, adapter, clock: () => now, running: () => 2 });
    now = 121000; // Active cadence is due, but the throttle deadline is not.
    await reader.requestRead({ reason: 'admission' });
    assert.equal(calls, 1);
    assert.equal(reader.snapshot(now).nextReadAtMs, 301000);
  } finally { await reader.close(); }
});
