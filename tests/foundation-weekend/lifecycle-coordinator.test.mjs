import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLendingLaunch } from '../../lib/v1/lending-launch.mjs';

// Synthetic frozen ports exercise the real durable launch journal, not coordinator signing.
const ok = value => ({ ok: true, value });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'launch-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1000, response = ok({ kind: 'fenced' });
  const calls = { release: [], ledger: [], start: 0 };
  const dependencies = {
    journal: { directory }, clock: () => now, settings: async () => ({ revision: 1 }),
    ledger: {
      compareAndReserve: async () => ({ kind: 'applied', value: { reservationId: 'reservation' }, revision: 1 }),
      release: async input => { calls.ledger.push(input); return { kind: 'applied' }; },
    },
    broker: {
      issueJobKey: async () => ok({ keyId: 'key-id', key: 'synthetic-key' }),
      revokeJobKey: async () => {},
    },
    providers: { getProvider: () => ok({ makeRun: ({ receipt, enforcement }) => ok({ receipt, enforcement }) }) },
    backend: {
      prepare: async () => ok({ sandboxId: 'sandbox' }),
      remove: async () => ok(null),
      start: async () => { calls.start++; return ok({ kind: 'started', atMs: now }); },
    },
    coordinator: {
      release: async input => { calls.release.push(structuredClone(input)); return structuredClone(response); },
      reconcile: async () => ok({ kind: 'fenced' }),
    },
  };
  const attempt = { attemptId: 'attempt', jobId: 'job', generation: 1,
    leaseProof: { schemaVersion: 1, signedEnvelope: 'synthetic-unused-proof' } };
  const selection = { providerId: 'provider', accountId: 'account', modelId: 'model', effortId: null };
  const amount = { unit: 'window_micro_points', byResource: [{ id: 'window', instance: 'epoch', amount: 1 }] };
  const receipt = { accountId: 'account', jobId: 'job', attemptId: 'attempt',
    quotedLedgerRevision: 0, settingsRevision: 1, amount };
  let launch = createLendingLaunch(dependencies);
  assert.equal((await launch.prepareLend({ attempt, selection, receipt, enforcement: { amount },
    operationId: 'prepare', signal: new AbortController().signal })).ok, true);
  return { calls, get launch() { return launch; },
    reboot() { launch = createLendingLaunch(dependencies); },
    response(value) { response = value; }, advance(ms) { now += ms; } };
}

for (const kind of ['fenced', 'uncertain', 'unexpected']) {
  test('unconfirmed release ' + kind + ' retains reservation and retries immutable intent after reboot', async t => {
    const f = await fixture(t);
    f.response(ok({ kind }));
    const input = { attemptId: 'attempt', reason: 'paused', operationId: 'release' };
    assert.equal((await f.launch.releaseBeforeStart(input)).ok, false);
    assert.equal(f.calls.ledger.length, 0, 'not a confirmed release of reservation');
    f.reboot();
    f.response(ok({ kind: 'already_released' }));
    assert.equal((await f.launch.releaseBeforeStart(input)).ok, true);
    assert.equal(f.calls.release.length, 2, 'uncertain attempt must not be cached as released');
    assert.deepEqual(f.calls.release[1], f.calls.release[0]);
    assert.equal(f.calls.ledger.length, 1);
    assert.equal((await f.launch.reoffer({ jobId: 'job', decision: { kind: 'lend' } })).eligible, false);
    f.advance(300000);
    assert.equal((await f.launch.reoffer({ jobId: 'job', decision: { kind: 'wait' } })).eligible, false);
    assert.equal((await f.launch.reoffer({ jobId: 'job', decision: { kind: 'lend' } })).eligible, true);
    assert.equal((await f.launch.startLend({ attemptId: 'attempt', operationId: 'start' })).ok, false);
    assert.equal(f.calls.start, 0);
    assert.equal((await f.launch.releaseBeforeStart(input)).ok, true);
    assert.equal(f.calls.release.length, 2, 'confirmed replay has no new coordinator effect');
    assert.equal((await f.launch.releaseBeforeStart({ ...input, reason: 'changed' })).error.code, 'operation_conflict');
  });
}
