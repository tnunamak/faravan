import {enableFixtureModel} from '../helpers/account-model-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createAccountStore, ok, fault } from '../../lib/v1/accounts.mjs';
import { createAccountBroker } from '../../lib/v1/account-broker.mjs';

// Synthetic effects only; these tests do not qualify any real API adapter.
const proof = { schemaVersion: 1, signedEnvelope: 'synthetic-proof' };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'api-replacement-'));
  let failPublication = false, refreshes = 0, transports = 0, holdStream = false;
  let authorizeHook = async () => {}, verifyHook = async () => {};
  let confirmed = true;
  const makeStore = () => createAccountStore({ directory, publishMetadata(file, value) {
    const committing = Object.values(value.replacementOperations ?? {}).some(op => op.status === 'completed');
    if (failPublication === true || (failPublication === 'commit' && committing)) throw new Error('synthetic publication failure');
    const temporary = file + '.synthetic';
    fs.writeFileSync(temporary, JSON.stringify(value)); fs.renameSync(temporary, file);
    if (failPublication === 'after-commit' && committing) throw new Error('synthetic ambiguous publication');
  } });
  const store = makeStore();
  const adapter = {
    descriptor: { schemaVersion: 1, id: 'synthetic-api', label: 'Synthetic API',
      signInKind: 'api_key', refreshKind: 'none', usageKind: 'none', maxConcurrentJobs: null,
      models: [{ id: 'model', label: 'Model', efforts: [], defaultEffort: null, enabled: true, rank: 0, pareto: null }],
      nativeUnits: [], destinations: [{ origin: 'https://synthetic.invalid', pathPrefixes: ['/v1/'], methods: ['POST'] }] },
    async beginSignIn() { return ok({ flowId: randomUUID(), state: 'waiting', presentation: { kind: 'key' } }); },
    async finishSignIn({ answer }) { const [subjectId, value] = answer.split(':'); return ok({ subjectId, secret: { synthetic: value }, expiresAtMs: null }); },
    async cancelSignIn() {},
    async refresh() { refreshes++; throw new Error('must never refresh'); },
    async readUsage() { return { kind: 'unavailable', code: 'synthetic' }; },
    async authorizeRequest({ auth, request }) { await authorizeHook(auth); return ok(request); },
    makeRun() { return fault('adapter_unsupported'); },
    classifyReplay() { return 'never'; },
    parseJobUsage() { return fault('adapter_unsupported'); },
  };
  const providers = { getProvider: id => id === adapter.descriptor.id ? ok(adapter) : fault('provider_not_found'),
    listProviders: () => [structuredClone(adapter.descriptor)] };
  const authority = { async verify() { await verifyHook(); return ok({ expiresAtMs: 900000, fence: 1 }); } };
  const proxy = { async dispatch() { transports++; return ok({ streamId: 'synthetic-upstream',
    response: new Response(holdStream ? new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); } }) : 'ok') }); },
    async revokeStreams() { return { aborted: confirmed ? ['synthetic-upstream'] : [], unconfirmed: confirmed ? [] : ['synthetic-upstream'] }; } };
  const brokers = [];
  const makeBroker = () => { const b = createAccountBroker({ store: makeStore(), providers, authority, proxy, clock: () => 1000 }); brokers.push(b); return b; };
  const broker = makeBroker();
  t.after(async () => { failPublication = false; confirmed = true; authorizeHook = async () => {}; verifyHook = async () => {};
    try { for (const b of brokers) await b.close(); } finally { fs.rmSync(directory, { recursive: true, force: true }); } });
  const enroll = async subject => {
    const flow = await broker.enroll({ providerId: adapter.descriptor.id, label: subject });
    const result = await broker.complete({ flowId: flow.value.flowId, answer: subject + ':original' });
    assert.equal(result.ok, true);
    await enableFixtureModel(store,result.value.id,'model');
    return { ...result.value, modelPreferences: store.get(result.value.id).modelPreferences };
  };
  const a = await enroll('a'), b = await enroll('b');
  const issue = (account = a) => broker.issueJobKey({ selection: { accountId: account.id, providerId: account.providerId, modelId: 'model', effortId: null },
    jobId: 'job', attemptId: 'attempt', leaseProof: proof });
  const begin = (host = broker) => host.beginCredentialReplacement({ accountId: a.id, expectedGeneration: 0 });
  const replace = async (answer = 'a:replacement', operationId = randomUUID(), host = broker) => {
    const flow = await begin(host); assert.equal(flow.ok, true);
    return host.completeCredentialReplacement({ flowId: flow.value.flowId, answer, operationId });
  };
  return { a, b, broker, store, adapter, issue, begin, replace, makeBroker, directory,
    request: { method: 'POST', url: 'https://synthetic.invalid/v1/messages', headers: {}, body: { kind: 'empty' } },
    setAuthorize: fn => { authorizeHook = fn; }, setVerify: fn => { verifyHook = fn; },
    setFailure: value => { failPublication = value; }, setConfirmed: value => { confirmed = value; },
    holdStream: () => { holdStream = true; },
    stats: () => ({ refreshes, transports }) };
}

test('same-subject replacement preserves preferences and B; replay is exact, changed payload conflicts', async t => {
  const f = await fixture(t);
  await f.store.transaction(state => { state.records[f.a.id].enabled = false; state.records[f.a.id].modelOrder = ['model']; });
  const beforeB = f.store.get(f.b.id), flow = await f.begin();
  assert.equal(flow.ok, true);
  const input = { flowId: flow.value.flowId, answer: 'a:replacement', operationId: 'replace-one' };
  const result = await f.broker.completeCredentialReplacement(input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.value, { ...f.a, enabled: false, modelOrder: ['model'], generation: 1 });
  assert.deepEqual(await f.broker.completeCredentialReplacement(input), result);
  assert.equal((await f.broker.completeCredentialReplacement({ ...input, answer: 'a:different' })).error.code, 'operation_conflict');
  assert.deepEqual(f.store.get(f.b.id), beforeB);
  assert.equal(f.store.get(f.a.id).generation, 1);
  assert.equal(f.store.get(f.a.id).secret.synthetic, 'replacement');
  assert.doesNotMatch(JSON.stringify(result), /subjectId|secret|replacementIntent/);
  assert.equal(f.stats().refreshes, 0);
});

test('other subject and flow-purpose interchange never mutate', async t => {
  const f = await fixture(t), before = f.store.get(f.a.id);
  assert.equal((await f.replace('other:replacement')).error.code, 'job_binding_mismatch');
  assert.deepEqual(f.store.get(f.a.id), before);
  const replacement = await f.begin();
  assert.equal((await f.broker.complete({ flowId: replacement.value.flowId, answer: 'a:replacement' })).ok, false);
  const enrollment = await f.broker.enroll({ providerId: f.a.providerId, label: 'new' });
  assert.equal((await f.broker.completeCredentialReplacement({ flowId: enrollment.value.flowId, answer: 'a:replacement', operationId: 'wrong-purpose' })).ok, false);
});

test('old authorization paused before admission never reaches transport after replacement', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const key = await f.issue(); assert.equal(key.ok, true);
  f.setAuthorize(async auth => { assert.equal(auth.generation, 0); entered.resolve(); await release.promise; });
  const dispatch = f.broker.proxy.dispatch({ key: key.value.key, request: f.request });
  await entered.promise;
  try { assert.equal((await f.replace()).ok, true); } finally { release.resolve(); }
  assert.equal((await dispatch).ok, false);
  assert.equal(f.stats().transports, 0);
  assert.equal((await f.broker.renewJobKey({ keyId: key.value.keyId, leaseProof: proof })).ok, false);
});

test('issue paused on old generation cannot mint a post-replacement key; B remains usable', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  f.setVerify(async () => { entered.resolve(); await release.promise; });
  const issue = f.issue(); await entered.promise;
  try { assert.equal((await f.replace()).ok, true); } finally { release.resolve(); }
  assert.equal((await issue).ok, false);
  f.setVerify(async () => {});
  assert.equal((await f.issue(f.b)).ok, true);
});

test('unsupported provider rejected before sign-in effects', async t => {
  const f = await fixture(t); let effects = 0;
  f.adapter.descriptor.signInKind = 'browser_oauth';
  f.adapter.beginSignIn = async () => { effects++; throw new Error('unexpected'); };
  assert.equal((await f.begin()).error.code, 'adapter_unsupported'); assert.equal(effects, 0);
});

test('unconfirmed active abort stays pending; restarted broker requires fresh verification', async t => {
  const f = await fixture(t), key = await f.issue();
  f.holdStream();
  const running = await f.broker.proxy.dispatch({ key: key.value.key, request: f.request });
  assert.equal(running.ok, true);
  f.setConfirmed(false);
  assert.equal((await f.replace()).error.code, 'credential_replacement_pending');
  assert.equal(f.store.get(f.a.id).generation, 0);
  assert.ok(f.store.get(f.a.id).replacementIntent);
  const restarted = f.makeBroker();
  assert.equal((await restarted.withAuth(f.a.id, async () => 'forbidden')).ok, false);
  f.setConfirmed(true);
  assert.equal((await f.replace('a:reverified', 'recover', restarted)).ok, true);
  assert.equal(f.store.get(f.a.id).generation, 1);
  assert.equal(f.stats().refreshes, 0);
});

test('publication failure is not success and unrelated account is untouched', async t => {
  const f = await fixture(t), beforeB = f.store.get(f.b.id);
  const flow = await f.begin(); assert.equal(flow.ok, true);
  f.setFailure(true);
  const result = await f.broker.completeCredentialReplacement({ flowId: flow.value.flowId, answer: 'a:replacement', operationId: 'fails' });
  f.setFailure(false);
  assert.equal(result.ok, false);
  assert.equal(f.store.get(f.a.id).generation, 0);
  assert.deepEqual(f.store.get(f.b.id), beforeB);
});

test('commit failure retains pending barrier; new flow safely re-verifies after restart', async t => {
  const f = await fixture(t), flow = await f.begin(), beforeB = f.store.get(f.b.id);
  f.setFailure('commit');
  const result = await f.broker.completeCredentialReplacement({ flowId: flow.value.flowId, answer: 'a:replacement', operationId: 'commit-fails' });
  f.setFailure(false);
  assert.equal(result.ok, false);
  assert.ok(f.store.get(f.a.id).replacementIntent);
  assert.equal(f.store.get(f.a.id).generation, 0);
  assert.equal((await f.issue()).ok, false);
  assert.deepEqual(f.store.get(f.b.id), beforeB);
  const restarted = f.makeBroker();
  assert.equal((await f.replace('a:verified-again', 'recovered', restarted)).ok, true);
  assert.equal(f.store.get(f.a.id).generation, 1);
});

test('ambiguous committed publication is replayed after restart without incrementing twice', async t => {
  const f = await fixture(t), flow = await f.begin();
  const input = { flowId: flow.value.flowId, answer: 'a:replacement', operationId: '__proto__' };
  f.setFailure('after-commit');
  assert.equal((await f.broker.completeCredentialReplacement(input)).ok, false);
  f.setFailure(false);
  assert.equal(f.store.get(f.a.id).generation, 1);
  const restarted = f.makeBroker(), replay = await restarted.completeCredentialReplacement(input);
  assert.equal(replay.ok, true); assert.equal(replay.value.generation, 1);
  assert.equal(f.store.get(f.a.id).generation, 1);
  assert.equal((await restarted.completeCredentialReplacement({ ...input, answer: 'a:changed' })).error.code, 'operation_conflict');
});

test('fresh replacement key uses new generation and normal reusable refresh still dispatches', async t => {
  const f = await fixture(t);
  assert.equal((await f.replace()).ok, true);
  const fresh = await f.issue(); assert.equal(fresh.ok, true);
  const result = await f.broker.proxy.dispatch({ key: fresh.value.key, request: f.request });
  assert.equal(result.ok, true); await result.value.response.text();
  assert.equal(f.stats().transports, 1);
  f.adapter.descriptor.signInKind = 'browser_oauth';
  f.adapter.descriptor.refreshKind = 'reusable';
  f.adapter.refresh = async () => ok({ secret: { synthetic: 'normal-rotation' }, expiresAtMs: 999999 });
  await f.store.compareAndSwap(f.b.id, 0, { expiresAtMs: 0 });
  const other = await f.issue(f.b); assert.equal(other.ok, true);
  const refreshed = await f.broker.proxy.dispatch({ key: other.value.key, request: f.request });
  assert.equal(refreshed.ok, true); await refreshed.value.response.text();
  assert.equal(f.store.get(f.b.id).generation, 1);
  assert.equal(f.stats().transports, 2);
});

test('renew queued across replacement is rejected after its authority check', async t => {
  const f = await fixture(t), key = await f.issue(), entered = deferred(), release = deferred();
  f.setVerify(async () => { entered.resolve(); await release.promise; });
  const renewal = f.broker.renewJobKey({ keyId: key.value.keyId, leaseProof: proof }); await entered.promise;
  try { assert.equal((await f.replace()).ok, true); } finally { release.resolve(); }
  assert.equal((await renewal).ok, false);
});

test('pending metadata contains no pasted answer or candidate; cancellation is not cessation', async t => {
  const f = await fixture(t), key = await f.issue(); f.holdStream(); f.setConfirmed(false);
  const running = await f.broker.proxy.dispatch({ key: key.value.key, request: f.request });
  assert.equal(running.ok, true);
  assert.equal((await f.replace('a:private-fixture-value')).error.code, 'credential_replacement_pending');
  const raw = fs.readFileSync(path.join(f.directory, 'accounts.json'), 'utf8');
  assert.doesNotMatch(raw, /private-fixture-value/);
  assert.equal(f.store.get(f.a.id).generation, 0);
  assert.ok(Object.keys(f.store.get(f.a.id).dispatchOperations).length);
});

async function closeCompletionFixture(t) {
  const f = await fixture(t), gates = [], jobs = [];
  let hold = null, finishResult = null, finishError = null, transactionError = null;
  const pause = async kind => {
    if (hold?.kind !== kind) return;
    const gate = hold; hold = null; gate.entered.resolve(); await gate.release.promise;
  };
  const store = { ...f.store, transaction: fn => f.store.transaction(async state => {
    await pause('transaction');
    if (transactionError) throw transactionError;
    return fn(state);
  }) };
  const originalFinish = f.adapter.finishSignIn;
  const adapter = { ...f.adapter, async finishSignIn(input) {
    await pause('provider');
    if (finishError) throw finishError;
    return finishResult ?? originalFinish(input);
  } };
  const broker = createAccountBroker({ store, providers: { getProvider: () => ok(adapter) },
    proxy: { async revokeStreams() { return { aborted: [], unconfirmed: [] }; } },
    authority: {}, clock: () => 1000 });
  const beforeB = f.store.get(f.b.id);
  return { ...f, broker, beforeB,
    arm(kind) { const gate = { kind, entered: deferred(), release: deferred() }; gates.push(gate); hold = gate; return gate; },
    track(job) { jobs.push(job); return job; },
    failProvider(result, error = null) { finishResult = result; finishError = error; },
    failTransaction(error) { transactionError = error; },
    async input(method) {
      const flow = method === 'complete'
        ? await broker.enroll({ providerId: f.a.providerId, label: 'c' })
        : await broker.beginCredentialReplacement({ accountId: f.a.id, expectedGeneration: 0 });
      assert.equal(flow.ok, true);
      return { flowId: flow.value.flowId, answer: method === 'complete' ? 'c:new' : 'a:new', operationId: randomUUID() };
    },
    async dispose() {
      for (const gate of gates) gate.release.resolve();
      await Promise.allSettled(jobs);
      await broker.close();
    },
  };
}
for (const method of ['complete', 'completeCredentialReplacement']) {
  for (const boundary of ['provider', 'transaction']) {
    test(method + ' close joins held ' + boundary + ' with real durable store', async t => {
      const f = await closeCompletionFixture(t);
      try {
        const input = await f.input(method), gate = f.arm(boundary);
        const completion = f.track(f.broker[method](input));
        await gate.entered.promise;
        let closed = false;
        const closing = f.track(f.broker.close().then(() => { closed = true; }));
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(closed, false, 'owned completion must settle before close');
        assert.equal((await f.broker[method](input)).error.code, 'account_signed_out');
        gate.release.resolve();
        const result = await completion; await closing;
        if (boundary === 'provider') assert.equal(result.error.code, 'account_signed_out');
        else if (method === 'complete') assert.equal(result.ok, true);
        else assert.equal(result.error.code, 'credential_replacement_pending');
        const durable = fs.readFileSync(path.join(f.directory, 'accounts.json'), 'utf8');
        const reopened = createAccountStore({ directory: f.directory });
        assert.deepEqual(reopened.get(f.b.id), f.beforeB);
        assert.equal(Object.keys(reopened.read().records).length,
          method === 'complete' && boundary === 'transaction' ? 3 : 2);
        if (method === 'completeCredentialReplacement') {
          assert.equal(reopened.get(f.a.id).generation, 0);
          assert.equal(Boolean(reopened.get(f.a.id).replacementIntent), boundary === 'transaction');
        }
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(fs.readFileSync(path.join(f.directory, 'accounts.json'), 'utf8'), durable);
      } finally { await f.dispose(); }
    });
  }
  test(method + ' success and failure contracts survive completion tracking', async t => {
    const f = await closeCompletionFixture(t);
    try {
      const input = await f.input(method), result = await f.broker[method](input);
      assert.equal(result.ok, true);
      if (method === 'completeCredentialReplacement')
        assert.deepEqual(await f.broker[method](input), result, 'exact durable replay');
      await f.broker.close();
      const reopened = createAccountStore({ directory: f.directory });
      assert.deepEqual(reopened.get(f.b.id), f.beforeB);
      assert.equal(reopened.get(result.value.id).generation, method === 'complete' ? 0 : 1);
    } finally { await f.dispose(); }
  });
  test(method + ' close preserves admitted provider failure and drains rejection', async t => {
    const f = await closeCompletionFixture(t);
    try {
      const input = await f.input(method), gate = f.arm('provider');
      const failure = fault('synthetic_provider_failure');
      f.failProvider(failure);
      const completion = f.track(f.broker[method](input));
      await gate.entered.promise;
      const closing = f.track(f.broker.close());
      gate.release.resolve();
      assert.deepEqual(await completion, failure, 'close must not replace original provider fault');
      await closing;
      assert.deepEqual(createAccountStore({ directory: f.directory }).get(f.b.id), f.beforeB);
    } finally { await f.dispose(); }
  });
  test(method + ' preserves provider exception mapping during close', async t => {
    const f = await closeCompletionFixture(t);
    try {
      const input = await f.input(method), gate = f.arm('provider');
      f.failProvider(null, new Error('synthetic finish failure'));
      const completion = f.track(f.broker[method](input));
      await gate.entered.promise;
      const closing = f.track(f.broker.close());
      gate.release.resolve();
      assert.equal((await completion).error.code,
        method === 'complete' ? 'signin_failed' : 'credential_replacement_pending');
      await closing;
      const reopened = createAccountStore({ directory: f.directory });
      assert.equal(Object.keys(reopened.read().records).length, 2);
      assert.deepEqual(reopened.get(f.b.id), f.beforeB);
    } finally { await f.dispose(); }
  });
  test(method + ' retains original transaction failure contract', async t => {
    const f = await closeCompletionFixture(t);
    try {
      const input = await f.input(method), gate = f.arm('transaction');
      const failure = new Error('synthetic transaction failure');
      f.failTransaction(failure);
      const completion = f.track(f.broker[method](input));
      const observed = completion.then(value => ({ value }), error => ({ error }));
      await gate.entered.promise;
      const closing = f.track(f.broker.close());
      gate.release.resolve();
      const result = await observed; await closing;
      if (method === 'complete') assert.equal(result.error, failure);
      else assert.equal(result.value.error.code, 'credential_replacement_pending');
      assert.equal(Object.keys(createAccountStore({ directory: f.directory }).read().records).length, 2);
    } finally { await f.dispose(); }
  });
}

for (const boundary of ['started', 'completed']) {
  test('new mutations refused after close ' + boundary + ' without durable effects', async t => {
    const f = await fixture(t);
    // This fixture alone opts into a real synthetic rotating descriptor.
    f.adapter.descriptor.signInKind = 'browser_oauth';
    f.adapter.descriptor.refreshKind = 'reusable';
    let refreshCalls = 0, reconcileCalls = 0, verifyCalls = 0;
    f.adapter.refresh = async () => {
      refreshCalls++;
      return ok({ secret: { synthetic: 'rotated-test-value' }, expiresAtMs: 999999 });
    };
    f.adapter.reconcileRotation = async () => { reconcileCalls++; return { kind: 'unchanged' }; };
    f.setVerify(async () => { verifyCalls++; });
    const refreshed = await f.broker.refreshAuth(f.a.id);
    assert.equal(refreshed.ok, true);
    assert.equal(refreshCalls, 1);
    assert.equal(f.store.get(f.a.id).generation, 1);
    assert.equal(f.store.get(f.a.id).secret.synthetic, 'rotated-test-value');
    const key = await f.issue();
    assert.equal(key.ok, true);
    assert.equal(verifyCalls, 1);
    await f.broker.revokeJobKey(key.value.keyId);
    // A third account proves ordinary pre-close removal remains available.
    const flow = await f.broker.enroll({ providerId: f.a.providerId, label: 'c' });
    assert.equal(flow.ok, true);
    const c = await f.broker.complete({ flowId: flow.value.flowId, answer: 'c:synthetic' });
    assert.equal(c.ok, true);
    assert.equal((await f.broker.remove(c.value.id)).ok, true);
    assert.equal(f.store.get(c.value.id), null);
    // B exercises the separate reconciliation branch, not only fresh refresh.
    await f.store.compareAndSwap(f.b.id, 0, { refreshIntent: { id: 'synthetic-pending', generation: 0, atMs: 0 } });
    // A separate broker with no keys/flows makes started-close assertions independent
    // of legitimate cleanup writes owned by the original broker.
    await f.broker.close();
    const host = f.makeBroker();
    const file = path.join(f.directory, 'accounts.json');
    const bytes = fs.readFileSync(file);
    const beforeA = f.store.get(f.a.id), beforeB = f.store.get(f.b.id);
    const counts = { refreshCalls, reconcileCalls, verifyCalls };
    const closing = host.close(); // closed becomes true synchronously.
    if (boundary === 'completed') await closing;
    const unchanged = () => {
      assert.deepEqual(fs.readFileSync(file), bytes, 'exact durable metadata bytes');
      const reopened = createAccountStore({ directory: f.directory });
      assert.deepEqual(reopened.get(f.a.id), beforeA);
      assert.deepEqual(reopened.get(f.b.id), beforeB);
      assert.deepEqual({ refreshCalls, reconcileCalls, verifyCalls }, counts);
    };
    const rejected = async (operation, id) => {
      assert.deepEqual(await operation(), fault('account_signed_out', id));
      unchanged();
    };
    try {
      await rejected(() => host.refreshAuth(f.a.id), f.a.id);
      await rejected(() => host.refreshAuth(f.b.id), f.b.id);
      await rejected(() => host.remove(f.a.id), f.a.id);
      await rejected(() => host.issueJobKey({
        selection: { accountId: f.a.id, providerId: f.a.providerId, modelId: 'model', effortId: null },
        jobId: 'late-job', attemptId: 'late-attempt', leaseProof: proof,
      }), f.a.id);
      // Refusal precedes proof validation as well as authority verification.
      await rejected(() => host.issueJobKey({
        selection: { accountId: f.a.id, providerId: f.a.providerId, modelId: 'model', effortId: null },
        jobId: 'late-job', attemptId: 'late-attempt', leaseProof: null,
      }), f.a.id);
    } finally { await closing; await host.close(); }
    unchanged();
  });
}

for (const method of ['enroll', 'beginCredentialReplacement']) {
  const inputFor = f => method === 'enroll'
    ? {providerId: f.a.providerId, label: 'late'}
    : {accountId: f.a.id, expectedGeneration: 0};
  test(method + ' ordinary begin and completion remain successful', async t => {
    const f = await fixture(t);
    const flow = await f.broker[method](inputFor(f));
    assert.equal(flow.ok, true);
    const result = method === 'enroll'
      ? await f.broker.complete({flowId: flow.value.flowId, answer: 'positive:synthetic'})
      : await f.broker.completeCredentialReplacement({flowId: flow.value.flowId, answer: 'a:synthetic', operationId: randomUUID()});
    assert.equal(result.ok, true);
    const reopened = createAccountStore({directory: f.directory});
    assert.equal(reopened.get(result.value.id).generation, method === 'enroll' ? 0 : 1);
    assert.deepEqual(reopened.get(f.b.id), f.store.get(f.b.id));
  });
  test(method + ' close owns held begin and exact late flow cancellation', async t => {
    const f = await fixture(t), entered = deferred(), release = deferred(), cancelEntered = deferred(), cancelRelease = deferred();
    const before = f.store.read(), flowId = randomUUID(), cancelled = [];
    let begins = 0, closed = false;
    f.adapter.beginSignIn = async () => { begins++; entered.resolve(); await release.promise; return ok({flowId}); };
    f.adapter.cancelSignIn = async id => { cancelled.push(id); cancelEntered.resolve(); await cancelRelease.promise; return ok(); };
    const beginning = f.broker[method](inputFor(f));
    let closing;
    try {
      await entered.promise;
      closing = f.broker.close().then(() => { closed = true; });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed, false);
      assert.equal((await f.broker[method](inputFor(f))).error.code, 'account_signed_out');
      assert.equal(begins, 1);
      release.resolve();
      assert.equal((await beginning).error.code, 'account_signed_out');
      await cancelEntered.promise;
      assert.deepEqual(cancelled, [flowId]);
      assert.equal(closed, false, 'close owns cancellation too');
      assert.equal((await f.broker.complete({flowId, answer: 'late:synthetic'})).ok, false);
      cancelRelease.resolve(); await closing;
      assert.deepEqual(createAccountStore({directory: f.directory}).read(), before);
      assert.equal((await f.broker[method](inputFor(f))).error.code, 'account_signed_out');
      assert.equal(begins, 1);
      await f.broker.close(); assert.deepEqual(cancelled, [flowId]);
    } finally { release.resolve(); cancelRelease.resolve(); await beginning; if (closing) await closing; }
  });

  test(method + ' registers ownership before synchronous provider close reentry', async t => {
    const f = await fixture(t), release = deferred(), flowId = randomUUID(), cancelled = [];
    let closing, closed = false;
    f.adapter.cancelSignIn = async id => { cancelled.push(id); return ok(); };
    f.adapter.beginSignIn = () => {
      closing = f.broker.close().then(() => { closed = true; });
      return release.promise;
    };
    const beginning = f.broker[method](inputFor(f));
    try {
      assert.ok(closing, 'provider invoked synchronously');
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(closed, false);
      release.resolve(ok({flowId}));
      assert.equal((await beginning).error.code, 'account_signed_out');
      await closing;
      assert.deepEqual(cancelled, [flowId]);
      assert.equal(Object.keys(createAccountStore({directory: f.directory}).read().records).length, 2);
    } finally { release.resolve(ok({flowId})); await beginning; if (closing) await closing; }
  });

  for (const failure of ['refused', 'throws']) {
    test(method + ' late cancellation ' + failure + ' remains retryable after close rejection', async t => {
      const f = await fixture(t), release = deferred(), flowId = randomUUID(), cancelled = [];
      let allow = false;
      f.adapter.beginSignIn = () => release.promise;
      f.adapter.cancelSignIn = async id => {
        cancelled.push(id);
        if (allow) return ok();
        if (failure === 'throws') throw new Error('synthetic cancellation failure');
        return fault('signin_cancel_failed');
      };
      const beginning = f.broker[method](inputFor(f));
      const closing = f.broker.close();
      const observed = assert.rejects(closing, {code: 'signin_cancel_failed'});
      try {
        release.resolve(ok({flowId}));
        assert.equal((await beginning).error.code, 'account_signed_out');
        await observed;
        assert.deepEqual(cancelled, [flowId]);
        assert.equal((await f.broker.complete({flowId, answer: 'late:synthetic'})).ok, false);
        allow = true; await f.broker.close();
        assert.deepEqual(cancelled, [flowId, flowId], 'same provider flow retained for retry');
        await f.broker.close(); assert.equal(cancelled.length, 2);
        assert.equal(Object.keys(createAccountStore({directory: f.directory}).read().records).length, 2);
      } finally { allow = true; release.resolve(ok({flowId})); await beginning; await observed; await f.broker.close(); }
    });
  }

  for (const failure of ['cancelled', 'rejected']) {
    test(method + ' close drains begin ' + failure + ' without invented cancellation', async t => {
      const f = await fixture(t), release = deferred();
      let cancels = 0;
      f.adapter.beginSignIn = async () => {
        await release.promise;
        if (failure === 'rejected') throw new Error('synthetic begin failure');
        return fault('signin_cancelled');
      };
      f.adapter.cancelSignIn = async () => { cancels++; return ok(); };
      const beginning = f.broker[method](inputFor(f)), closing = f.broker.close();
      try {
        release.resolve();
        assert.equal((await beginning).error.code, failure === 'rejected' ? 'signin_failed' : 'signin_cancelled');
        await closing; assert.equal(cancels, 0);
        assert.equal(Object.keys(createAccountStore({directory: f.directory}).read().records).length, 2);
      } finally { release.resolve(); await beginning; await closing; }
    });
  }
}

for (const failure of ['refused','throws']) {
  test('close cancels other late sign-ins when one cancellation '+failure, async t => {
    const f=await fixture(t), first=deferred(), second=deferred();
    const ids=[randomUUID(),randomUUID()], calls=[];
    let begun=0, allowFirst=false;
    f.adapter.beginSignIn=()=>[first.promise,second.promise][begun++];
    f.adapter.cancelSignIn=async id=>{
      calls.push(id);
      if(id!==ids[0]||allowFirst)return ok();
      if(failure==='throws')throw new Error('synthetic cancellation failure');
      return fault('signin_cancel_failed');
    };
    const input={providerId:f.a.providerId,label:'synthetic held sign-in'};
    const begins=[f.broker.enroll(input),f.broker.enroll(input)];
    const closing=f.broker.close();
    const checked=assert.rejects(closing,{code:'signin_cancel_failed'});
    try {
      first.resolve(ok({flowId:ids[0]}));
      assert.equal((await begins[0]).error.code,'account_signed_out');
      second.resolve(ok({flowId:ids[1]}));
      assert.equal((await begins[1]).error.code,'account_signed_out');
      await checked;
      assert.deepEqual(calls,ids,'the first failure cannot skip the other owned flow');
      allowFirst=true;
      await f.broker.close();
      await f.broker.close();
      assert.deepEqual(calls,[...ids,ids[0]],'only the exact unresolved flow is retried');
    } finally {
      allowFirst=true;
      first.resolve(ok({flowId:ids[0]})); second.resolve(ok({flowId:ids[1]}));
      await Promise.allSettled([...begins,checked]);
      await f.broker.close();
    }
  });
}

test('close revokes an existing job key before waiting for a held sign-in', async t => {
  const f = await fixture(t), entered = deferred(), release = deferred();
  const issued = await f.issue();
  assert.equal(issued.ok, true);
  let renewals = 0;
  f.setVerify(() => { renewals++; });
  f.adapter.beginSignIn = () => { entered.resolve(); return release.promise; };
  const beginning = f.broker.enroll({providerId:f.a.providerId, label:'held'});
  await entered.promise;
  const closing = f.broker.close();
  try {
    const renewed = await f.broker.renewJobKey({keyId:issued.value.keyId, leaseProof:proof});
    assert.equal(renewed.error?.code, 'job_key_revoked');
    assert.equal(renewals, 0, 'the revoked key never reaches authority verification');
  } finally {
    release.resolve(fault('signin_cancelled'));
    await beginning;
    await closing;
  }
});
