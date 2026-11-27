import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {runJob} from '../../lib/executor.mjs';
import {accountKey, accountIdOfKey, isAccountKey, providerOfKey} from '../../lib/v1/lending-account-key.mjs';

// Stop at the real executor's prepare call. No handle, native store or process exists.
function boundary() {
  const stop = new Error('owned preparation-routing boundary');
  const seen = [];
  const calls = {admit: 0, probe: 0, start: 0, destroy: 0};
  const backend = {
    async admitJob() { calls.admit++; return {ok: true}; },
    async probeCapabilities() { calls.probe++; return {available: true}; },
    async prepare(spec, options) { seen.push({spec, options}); throw stop; },
    async start() { calls.start++; throw new Error('unexpected launch'); },
    async destroy() { calls.destroy++; throw new Error('unexpected handle'); },
  };
  return {stop, seen, calls, backend};
}
const guest = () => ({
  job_id: 'guest-fixture',
  entrypoint: ['never-executed'],
  accountKey: 'guest-selection-is-not-authority',
  preparationContext: {jobId: 'forged', attemptId: 'forged', generation: 999},
});
function addedAccount() {
  const account = {provider: 'claude', id: randomUUID()};
  const key = accountKey(account);
  assert.equal(isAccountKey(key), true);
  assert.equal(providerOfKey(key), account.provider);
  assert.equal(accountIdOfKey(key), account.id);
  return key;
}
function untouched(b, spec, before) {
  assert.deepEqual(spec, before);
  assert.equal(b.calls.start, 0);
  assert.equal(b.calls.destroy, 0);
}
async function reachPrepare(accountSelection, {trusted = true, omitSelection = false} = {}) {
  const b = boundary(), spec = guest(), before = structuredClone(spec);
  const controller = new AbortController(), wallRemainingMs = () => 3210;
  const preparationContext = Object.freeze({jobId: 'accepted', attemptId: 'host-attempt', generation: 3});
  await assert.rejects(runJob({
    jobSpec: spec, backend: b.backend, signal: controller.signal, wallRemainingMs,
    ...(!omitSelection ? {accountKey: accountSelection} : {}),
    ...(trusted ? {preparationContext} : {}),
  }), error => error === b.stop);
  assert.deepEqual(b.calls, {admit: 1, probe: 1, start: 0, destroy: 0});
  assert.equal(b.seen.length, 1);
  assert.equal(b.seen[0].spec, spec);
  const expected = {signal: controller.signal, wallRemainingMs, separatePreparationClock: true,
    ...(accountIdOfKey(accountSelection) !== null ? {accountKey: accountSelection} : {}),
    ...(trusted ? {preparationContext} : {})};
  assert.deepEqual(b.seen[0].options, expected);
  assert.equal(b.seen[0].options.signal, controller.signal);
  assert.equal(b.seen[0].options.wallRemainingMs, wallRemainingMs);
  if (trusted) assert.equal(b.seen[0].options.preparationContext, preparationContext);
  else assert.equal(Object.hasOwn(b.seen[0].options, 'preparationContext'), false);
  untouched(b, spec, before);
  return b;
}
test('valid added account retains exact key and trusted context, signal and wall budget', async () => {
  const key = addedAccount();
  const b = await reachPrepare(key);
  assert.equal(b.seen[0].options.accountKey, key);
});
test('omitted, null and legacy bare-provider accounts retain default routing', async () => {
  const legacy = accountKey({provider: 'claude', id: randomUUID(), legacy_provider: 'claude'});
  assert.equal(legacy, 'claude');
  for (const [key, omitSelection] of [[undefined, true], [null, false], [legacy, false]]) {
    const b = await reachPrepare(key, {omitSelection});
    assert.equal(Object.hasOwn(b.seen[0].options, 'accountKey'), false);
  }
});
test('added-account routing does not depend on trusted context and ignores forged guest context', async () => {
  const key = addedAccount();
  const b = await reachPrepare(key, {trusted: false});
  assert.equal(b.seen[0].options.accountKey, key);
});
test('invalid account selection refuses before prepare, regardless of trusted metadata', async () => {
  for (const key of ['', 'claude:not-a-uuid', 'claude:0', 'CLAUDE', addedAccount() + '#1']) {
    assert.equal(isAccountKey(key), false);
    const b = boundary(), spec = guest(), before = structuredClone(spec);
    await assert.rejects(runJob({jobSpec: spec, backend: b.backend, accountKey: key,
      preparationContext: Object.freeze({jobId: 'accepted', attemptId: 'host-attempt', generation: 3}),
    }), error => error.code === 'claude_account_unavailable' && error !== b.stop);
    assert.deepEqual(b.seen, []);
    assert.deepEqual(b.calls, {admit: 1, probe: 1, start: 0, destroy: 0});
    untouched(b, spec, before);
  }
});
test('pre-aborted valid added-account selection never reaches admission or prepare', async () => {
  const b = boundary(), spec = guest(), before = structuredClone(spec);
  const controller = new AbortController(), reason = new Error('cancel before preparation');
  controller.abort(reason);
  await assert.rejects(runJob({jobSpec: spec, backend: b.backend, accountKey: addedAccount(),
    signal: controller.signal}), error => error === reason);
  assert.deepEqual(b.seen, []);
  assert.deepEqual(b.calls, {admit: 0, probe: 0, start: 0, destroy: 0});
  untouched(b, spec, before);
});
