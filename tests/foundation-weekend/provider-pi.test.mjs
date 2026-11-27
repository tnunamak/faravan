import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostAdapter } from '../../lib/v1/providers/host-adapter.mjs';

// These are fail-closed port regressions, NOT local pi conformance. No frozen
// RunSpec or authorization request schema is available in this assignment.
// Deliberately do not supply a signInSpec: no dynamic sign-in import, process,
// filesystem, credential store, browser, provider or network effect is used.
function assertUnsupported(value) {
  // The fault envelope belongs to the frozen accounts contract outside this
  // scope. Check the named refusal without inventing a replacement envelope.
  assert.match(JSON.stringify(value), /"adapter_unsupported"/);
}

test('conservative missing-contract assumption: no default pi run or authorization route', async () => {
  const adapter = createHostAdapter({ descriptor: undefined });
  // Opaque probes are intentionally not claimed to be valid RunSpecs.
  for (const accountId of ['synthetic-account-a', 'synthetic-account-b']) {
    const probe = Object.freeze({ accountId, jobId: 'job', attemptId: 'attempt' });
    assertUnsupported(adapter.makeRun(probe));
    assertUnsupported(await adapter.authorizeRequest(probe));
  }
  assert.equal(adapter.classifyReplay({}), 'never');
});

test('conservative missing-contract assumption: missing enrollment stays unsupported before and after cancellation', async () => {
  const adapter = createHostAdapter({ descriptor: undefined });
  const controller = new AbortController();
  try {
    assertUnsupported(await adapter.beginSignIn({ accountId: 'synthetic-account-a', signal: controller.signal }));
    await adapter.cancelSignIn('synthetic-account-a');
    // Cancelling a non-existent flow cannot enable another account.
    assertUnsupported(await adapter.beginSignIn({ accountId: 'synthetic-account-b', signal: controller.signal }));
    controller.abort();
    assertUnsupported(await adapter.beginSignIn({ accountId: 'synthetic-account-a', signal: controller.signal }));
  } finally {
    controller.abort();
    await adapter.cancelSignIn('synthetic-account-a');
    await adapter.cancelSignIn('synthetic-account-b');
  }
});

test('conservative missing-contract assumption: failed injected authorization is not replaced by a default route', async () => {
  const sentinel = new Error('synthetic authorization failure');
  const calls = [];
  const adapter = createHostAdapter({ descriptor: undefined, effects: {
    authorizeRequest: async probe => { calls.push(probe); throw sentinel; },
  } });
  for (const accountId of ['synthetic-account-a', 'synthetic-account-b']) {
    const probe = Object.freeze({ accountId, jobId: 'job', attemptId: 'attempt' });
    await assert.rejects(adapter.authorizeRequest(probe), error => error === sentinel);
    assert.equal(calls.at(-1), probe);
    assertUnsupported(adapter.makeRun(probe));
  }
  assert.equal(calls.length, 2);
});
