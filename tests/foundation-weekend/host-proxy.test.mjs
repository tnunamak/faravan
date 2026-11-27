import assert from 'node:assert/strict';
import test from 'node:test';
import { createAccountBroker } from '../../lib/v1/account-broker.mjs';

// Bounded broker evidence-retention regressions, not a new HostProxy transport.
// All account data and upstream effects are synthetic and in memory.
function fixture(t, dispatch) {
  const state = { accountOrder: ['account'], records: { account: {
    schemaVersion: 1, id: 'account', providerId: 'fixture', label: 'Fixture',
    authState: 'signed_in', generation: 0, expiresAtMs: null,
    enabled: true, modelOrder: [], modelPreferences:{model:{enabled:true,effortIds:null}}, dispatchOperations: {}, guestKeys: {},
  } } };
  const store = {
    read: () => structuredClone(state),
    get: id => structuredClone(state.records[id]),
    transaction: async fn => fn(state),
    exclusive: async (_id, fn) => fn(),
  };
  let receipt = { aborted: [], unconfirmed: ['upstream'] };
  let calls = 0, disposals = 0;
  const adapter = {
    descriptor: { refreshKind: 'none',
      models: [{ id: 'model', enabled: true, efforts: [], defaultEffort: null }],
      destinations: [{ origin: 'https://fixture.invalid', methods: ['POST'], pathPrefixes: ['/run'] }] },
    authorizeRequest: async ({ request }) => ({ ok: true, value: request }),
  };
  const dependencies = { store, providers: { getProvider: () => ({ ok: true, value: adapter }) },
    clock: () => 1000,
    authority: { verify: async () => ({ ok: true, value: { fence: 1, expiresAtMs: 90000 } }) },
    proxy: { dispatch: async input => { calls++; return dispatch(input); },
      revokeStreams: async () => receipt } };
  const broker = createAccountBroker(dependencies);
  const recovered = createAccountBroker(dependencies);
  t.after(async () => { await recovered.close(); await broker.close(); });
  const request = { method: 'POST', url: 'https://fixture.invalid/run', headers: {},
    body: { kind: 'one_shot', dispose: async () => { disposals++; } } };
  return { broker, recovered, state, request,
    key: () => broker.issueJobKey({ selection: { accountId: 'account', providerId: 'fixture', modelId: 'model', effortId: null },
      jobId: 'job', attemptId: 'attempt', leaseProof: { schemaVersion: 1, signedEnvelope: 'synthetic' } }),
    counts: () => ({ calls, disposals }),
    confirm: () => { receipt = { aborted: ['upstream'], unconfirmed: [] }; } };
}
for (const body of ['finished stream', 'no body']) {
  test(body + ' retains operation until explicit correlated revocation receipt', async t => {
    const f = fixture(t, async () => ({ ok: true, value: { streamId: 'upstream',
      response: body === 'no body' ? new Response(null, { status: 204 }) : new Response('finished') } }));
    const key = await f.key(); assert.equal(key.ok, true);
    const result = await f.broker.proxy.dispatch({ key: key.value.key, request: f.request, signal: new AbortController().signal });
    assert.equal(result.ok, true);
    await result.value.response.text();
    assert.equal(Object.keys(f.state.records.account.dispatchOperations).length, 1);
    assert.equal(Object.values(f.state.records.account.dispatchOperations)[0].upstreamId, 'upstream');
    assert.deepEqual(f.counts(), { calls: 1, disposals: 1 });
    // A second broker has no in-memory bearer but sees the durable removal ledger.
    const pending = await f.recovered.remove('account');
    assert.equal(pending.ok, false);
    assert.equal(pending.error.code, 'account_removal_pending');
    assert.equal(Object.keys(f.state.records.account.dispatchOperations).length, 1);
    f.confirm();
    assert.equal((await f.recovered.remove('account')).ok, true);
    assert.equal(f.state.records.account, undefined);
    assert.deepEqual(f.counts(), { calls: 1, disposals: 1 });
  });
}
test('ambiguous dispatch retains unknown operation and cannot replay one-shot body', async t => {
  const f = fixture(t, async () => { throw new Error('unknown dispatch response'); });
  const key = await f.key(); assert.equal(key.ok, true);
  const invoke = () => f.broker.proxy.dispatch({ key: key.value.key, request: f.request });
  assert.equal((await invoke()).ok, false);
  assert.equal((await invoke()).error.code, 'body_already_consumed');
  assert.deepEqual(f.counts(), { calls: 1, disposals: 1 });
  const operations = Object.values(f.state.records.account.dispatchOperations);
  assert.equal(operations.length, 1); assert.equal(operations[0].upstreamId, null);
  f.confirm(); // A different/unknown upstream identity is not correlation evidence.
  assert.equal((await f.recovered.remove('account')).error.code, 'account_removal_pending');
  assert.equal(Object.keys(f.state.records.account.dispatchOperations).length, 1);
});
