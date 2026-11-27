import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../../lib/v1/providers/host-adapter.mjs';

// Conservative assumption: API-key behavior remains owned by injected host
// effects until the enrollment/configuration contract is supplied. These tests
// qualify forwarding only, NOT API-key enrollment, rotation, storage or safety.
const descriptor = {
  schemaVersion: 1, id: 'fixture-api', label: 'Fixture API',
  signInKind: 'api_key', refreshKind: 'none', usageKind: 'none',
  maxConcurrentJobs: null, models: [], nativeUnits: [], destinations: [],
};
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('conservative host-port assumption: concurrent accounts retain separate inputs and replies', async () => {
  const a = deferred(), b = deferred(), seen = [];
  let refreshCalls = 0;
  const adapter = createHostAdapter({ descriptor, effects: {
    authorizeRequest(input) {
      seen.push(input);
      return input.auth.accountId === 'a' ? a.promise : b.promise;
    },
    refresh() { refreshCalls++; throw new Error('unexpected refresh'); },
  } });
  const first = { auth: { accountId: 'a', generation: 1, secret: { key: 'FAKE_A' } },
    request: { method: 'POST', url: 'https://fixture.invalid/a' } };
  const second = { auth: { accountId: 'b', generation: 4, secret: { key: 'FAKE_B' } },
    request: { method: 'POST', url: 'https://fixture.invalid/b' } };
  const pendingA = adapter.authorizeRequest(first);
  const pendingB = adapter.authorizeRequest(second);
  assert.equal(seen[0], first);
  assert.equal(seen[1], second);
  const replyB = { ok: true, value: { headers: { authorization: 'FAKE_B' } } };
  const replyA = { ok: true, value: { headers: { authorization: 'FAKE_A' } } };
  b.resolve(replyB);
  assert.equal(await pendingB, replyB);
  a.resolve(replyA);
  assert.equal(await pendingA, replyA);
  assert.equal(refreshCalls, 0);
});

test('conservative host-port assumption: later generation and refusal are forwarded unchanged', async () => {
  const seen = [];
  const denied = { ok: false, error: { code: 'destination_denied' } };
  const replacement = { ok: true, value: { headers: { authorization: 'FAKE_NEW' } } };
  const adapter = createHostAdapter({ descriptor, effects: {
    authorizeRequest(input) {
      seen.push(input);
      return Promise.resolve(input.auth.generation === 2 ? replacement : denied);
    },
  } });
  const old = { auth: { accountId: 'a', generation: 1, secret: { key: 'FAKE_OLD' } } };
  const next = { auth: { accountId: 'a', generation: 2, secret: { key: 'FAKE_NEW' } } };
  assert.equal(await adapter.authorizeRequest(old), denied);
  assert.equal(await adapter.authorizeRequest(next), replacement);
  assert.deepEqual(seen, [old, next]);
  // Refusal/replacement policy above is synthetic, not a broker implementation.
});

test('conservative host-port assumption: run creation does not implicitly authorize or refresh', () => {
  let authorizations = 0, refreshes = 0, seen;
  const run = { ok: true, value: { schemaVersion: 1, env: { JOB_KEY: 'FAKE_GUEST' } } };
  const adapter = createHostAdapter({ descriptor, effects: {
    makeRun(input) { seen = input; return run; },
    authorizeRequest() { authorizations++; throw new Error('unexpected authorization'); },
    refresh() { refreshes++; throw new Error('unexpected refresh'); },
  } });
  const input = { selection: { providerId: 'fixture-api', accountId: 'a', modelId: 'fixture-model', effortId: null },
    jobKey: 'FAKE_GUEST', job: { jobId: 'job', attemptId: 'attempt' } };
  assert.equal(adapter.makeRun(input), run);
  assert.equal(seen, input);
  assert.equal(authorizations, 0);
  assert.equal(refreshes, 0);
});
