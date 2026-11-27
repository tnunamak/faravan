import {enableFixtureModel} from '../helpers/account-model-fixture.mjs';
import {tempDir} from '../helpers/temp-dir.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { createAccountStore, ok } from '../../lib/v1/accounts.mjs';
import { createAccountBroker } from '../../lib/v1/account-broker.mjs';
import { getAccountUsage } from '../../lib/v1/account-usage.mjs';
import { createFakeRegistry } from '../../lib/v1/providers/fixtures.mjs';
import { parseRetryAfter } from '../../lib/v1/providers/index.mjs';

const scratch = tempDir('foundation-a-work-');
let serial = 0;
function fixture(t, effects = {}, options = {}) {
  const directory = `${scratch}/fixture-${process.pid}-${serial++}`;
  const store = createAccountStore({ directory });
  let time = 1000000, dispatches = 0;
  const providers = createFakeRegistry(effects);
  const authority = { verify: async ({ proof, selection, jobId, attemptId }) => {
    if (!proof || proof.signedEnvelope !== 'synthetic-proof' || jobId !== 'job' || attemptId !== 'attempt') return { ok: false, error: { code: 'lease_invalid' } };
    return ok({ expiresAtMs: time + 600000, fence: 3 });
  }, fence: async () => ok() };
  const proxy = { dispatch: async ({ request }) => { dispatches++; assert.match(request.headers.authorization, /SYNTHETIC/);
    assert.equal(request.headers.cookie, undefined); return ok({ streamId: 'upstream', response: new Response('done') }); },
    revokeStreams: async () => ({ aborted: [], unconfirmed: ['synthetic-upstream'] }) };
  const broker = createAccountBroker({ store, providers, clock: () => time, proxy, authority, ...options });
  t.after(async () => {
    try { await broker.close(); }
    finally { fs.rmSync(directory, { recursive: true, force: true }); }
  });
  async function enroll(providerId = 'claude', subject = 'subject-1') {
    const flow = await broker.enroll({ providerId, label: 'Test', signal: new AbortController().signal });
    assert.equal(flow.ok, true);
    const result=await broker.complete({ flowId: flow.value.flowId, answer: subject });
    if(result.ok)await enableFixtureModel(store,result.value.id,'fixture-model');
    return result;
  }
  return { store, providers, broker, directory, enroll, authority, proxy,
    get time() { return time; }, set time(value) { time = value; }, get dispatches() { return dispatches; } };
}
const selection = account => ({ providerId: account.providerId, accountId: account.id, modelId: 'fixture-model', effortId: null });
const issue = (f, account, proof = { schemaVersion: 1, signedEnvelope: 'synthetic-proof' }) => f.broker.issueJobKey({ selection: selection(account), jobId: 'job', attemptId: 'attempt', leaseProof: proof });
const request = (changes = {}) => ({ method: 'POST', url: 'https://synthetic.invalid/v1/messages', headers: { authorization: 'guest', cookie: 'guest-cookie' }, body: { kind: 'empty' }, ...changes });

test('four adapter fixtures conform; two same-provider subjects coexist and duplicate is opaque', async t => {
  const f = fixture(t);
  for (const provider of f.providers.listProviders()) {
    const result = await f.enroll(provider.id, 'one'); assert.equal(result.ok, true);
    const second = await f.enroll(provider.id, 'two'); assert.equal(second.ok, true);
    const duplicate = await f.enroll(provider.id, 'one'); assert.equal(duplicate.error.code, 'account_exists');
    assert.equal(duplicate.error.nextAction.target.accountId, result.value.id);
    assert.notEqual(result.value.id, second.value.id);
    const adapter = f.providers.getProvider(provider.id).value;
    const run = adapter.makeRun({ selection: selection(result.value), jobKey: 'SYNTHETIC-GUEST-KEY', receipt: {}, enforcement: {} });
    assert.equal(run.ok, true); assert.doesNotMatch(JSON.stringify(run), /SYNTHETIC-HOST-ONLY/);
    assert.equal(adapter.parseJobUsage({ accountId: result.value.id, attemptId: 'attempt', event: event(result.value.id, 1) }).ok, true);
  }
  assert.equal((await f.broker.list()).length, 8);
  assert.doesNotMatch(JSON.stringify(await f.broker.list()), /sentinel|subjectId|secret|refreshIntent/);
});

test('20 consumers, two broker instances, one durable rotation; restart reuses generation', async t => {
  let rotations = 0;
  const f = fixture(t, { refresh: async () => { rotations++; await new Promise(resolve => setTimeout(resolve, 10)); return ok({ secret: { sentinel: 'SYNTHETIC-ROTATED' }, expiresAtMs: 999999999 }); } });
  const account = (await f.enroll()).value;
  await f.store.compareAndSwap(account.id, 0, { expiresAtMs: f.time });
  const second = createAccountBroker({ store: createAccountStore({ directory: f.directory }), providers: f.providers,
    clock: () => f.time, proxy: f.proxy, authority: f.authority });
  t.after(() => second.close());
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? second : f.broker).withAuth(account.id, async auth => auth.generation)));
  assert.ok(results.every(r => r.ok && r.value === 1)); assert.equal(rotations, 1);
  await second.withAuth(account.id, async () => {}); assert.equal(rotations, 1);
});

test('kernel lock and generation CAS serialize two actual child processes', async t => {
  const f = fixture(t); const account = (await f.enroll()).value;
  await f.store.compareAndSwap(account.id, 0, { expiresAtMs: f.time });
  const source = `import {createAccountStore,ok} from './lib/v1/accounts.mjs';
import {createAccountBroker} from './lib/v1/account-broker.mjs';
import {createFakeRegistry} from './lib/v1/providers/fixtures.mjs';
import fs from 'node:fs';
const store=createAccountStore({directory:process.argv[1]});
const broker=createAccountBroker({store,providers:createFakeRegistry({refresh:async()=>{
fs.appendFileSync(process.argv[1]+'/rotations','one\\n');await new Promise(r=>setTimeout(r,30));
return ok({secret:{sentinel:'SYNTHETIC'},expiresAtMs:999999999});}}),clock:()=>1000000});
const result=await broker.withAuth(process.argv[2],async a=>a.generation);
if(!result.ok||result.value!==1)process.exitCode=1;await broker.close();`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.directory, account.id], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stderr.on('data', bytes => { output += bytes; });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(output)));
  });
  await Promise.all([run(), run()]);
  assert.equal(fs.readFileSync(`${f.directory}/rotations`, 'utf8'), 'one\n');
  assert.equal(await f.store.compareAndSwap(account.id, 0, { secret: 'stale' }), false);
});

test('possible rotation before crash is never replayed without reconciliation', async t => {
  let rotations = 0;
  const f = fixture(t, { refresh: async () => { rotations++; throw new Error('synthetic crash'); } });
  const account = (await f.enroll()).value;
  await f.store.compareAndSwap(account.id, 0, { expiresAtMs: f.time });
  assert.equal((await f.broker.withAuth(account.id, async () => {})).error.code, 'auth_temporarily_unavailable');
  assert.ok(f.store.get(account.id).refreshIntent);
  assert.equal((await f.broker.withAuth(account.id, async () => {})).error.code, 'reauthorization_required');
  assert.equal(rotations, 1);
});

test('recovered rotation publishes by CAS; none-refresh providers make zero calls', async t => {
  let rotations = 0;
  const f = fixture(t, { refresh: async () => { rotations++; throw new Error(); },
    reconcileRotation: async () => ({ kind: 'recovered', rotation: { secret: { sentinel: 'SYNTHETIC-RECOVERED' }, expiresAtMs: 999999999 } }) });
  const account = (await f.enroll()).value;
  await f.store.compareAndSwap(account.id, 0, { refreshIntent: { id: 'crashed' } });
  assert.equal((await f.broker.withAuth(account.id, async a => a.generation)).value, 1);
  for (const id of ['pi', 'generic-api-key']) {
    const a = (await f.enroll(id)).value; await f.store.compareAndSwap(a.id, 0, { expiresAtMs: f.time });
    assert.equal((await f.broker.withAuth(a.id, async () => 'used')).ok, true);
  }
  assert.equal(rotations, 0);
});

test('guest binding, proof, expiry, destination, revocation all deny before upstream', async t => {
  const f = fixture(t); const account = (await f.enroll()).value;
  assert.equal((await issue(f, account, { signedEnvelope: 'forged' })).error.code, 'lease_invalid');
  const key = (await issue(f, account)).value;
  const dispatch = req => f.broker.proxy.dispatch({ key: key.key, request: req });
  for (const [header, value] of [['x-faravan-account-id', 'other'], ['x-faravan-job-id', 'other'], ['x-faravan-attempt-id', 'other']]) {
    assert.equal((await dispatch(request({ headers: { [header]: value } }))).error.code, 'job_binding_mismatch');
  }
  for (const changes of [{ url: 'https://evil.invalid/v1/messages' }, { url: 'https://synthetic.invalid/v1/messages?accountId=other' }, { method: 'DELETE' }]) {
    assert.equal((await dispatch(request(changes))).error.code, 'destination_denied');
  }
  f.authority.verify = async () => ok({ expiresAtMs: f.time + 1000, fence: 2 });
  assert.equal((await dispatch(request())).error.code, 'lease_fenced');
  f.authority.verify = async () => { throw new Error(); };
  assert.equal((await dispatch(request())).error.code, 'authority_unavailable');
  f.time += 300001;
  assert.equal((await dispatch(request())).error.code, 'job_key_expired');
  await f.broker.revokeJobKey(key.keyId);
  assert.equal((await dispatch(request())).error.code, 'job_key_revoked');
  assert.equal(f.dispatches, 0);
});

test('one shot disposal, no ambiguous replay, revoke unconfirmed does not claim cessation', async t => {
  const f = fixture(t); const account = (await f.enroll()).value; const key = (await issue(f, account)).value;
  let disposed = 0;
  const body = { kind: 'one_shot', stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([1])); c.close(); } }), dispose: async () => { disposed++; } };
  const result = await f.broker.proxy.dispatch({ key: key.key, request: request({ body }) });
  assert.equal(result.ok, true); assert.equal(await result.value.response.text(), 'done');
  assert.equal(disposed, 1); assert.equal(f.dispatches, 1);
  const stopped = await f.broker.revokeJobKey(key.keyId); assert.ok(stopped.unconfirmed.includes('synthetic-upstream'));
  assert.equal(Object.keys(f.store.get(account.id).dispatchOperations).every(id=>stopped.unconfirmed.includes(id)),true,'durable operations remain explicitly unconfirmed');
  f.proxy.dispatch = async () => { throw new Error('ambiguous'); };
  const other = (await issue(f, account)).value; disposed = 0;
  assert.equal((await f.broker.proxy.dispatch({ key: other.key, request: request({ body: { ...body, dispose: async () => { disposed++; } } }) })).ok, false);
  assert.equal(disposed, 1);
});

const reading = (id, now, sequence = 1, coverage = { kind: 'unknown' }) => ({ schemaVersion: 1, accountId: id,
  observationId: `observation-${sequence}`, sequence, observedAtMs: now, receivedAtMs: now,
  windows: [], postingUncertaintyMs: null, coverage });
const event = (id, sequence, value = 5, changes = {}) => ({ schemaVersion: 1, accountId: id,
  attemptId: 'attempt', eventId: `event-${sequence}`, sequence, atMs: 1000000, semantics: 'delta', meterEpoch: 'epoch-1',
  amount: { unit: 'tokens', value }, windowDebits: [{ id: 'week', instance: 'week-1', micro: value }], ...changes });

test('shared durable cadence and full Retry-After survive reader restart; age never restamped', async t => {
  let calls = 0;
  const f = fixture(t, { readUsage: async ({ auth }) => {
    calls++; return calls === 1 ? { kind: 'reading', reading: reading(auth.accountId, f.time - 10000) } : { kind: 'throttled', retryAtMs: f.time + 7200000 };
  } });
  const account = (await f.enroll()).value; const usage = f.broker.getAccountUsage(account.id);
  const observedAtMs = f.time - 10000;
  const priorReading = reading(account.id, observedAtMs);
  const snapshots = await Promise.all(Array.from({ length: 20 }, () => usage.requestRead({ reason: 'guard' })));
  assert.equal(calls, 1); assert.equal(snapshots[0].ageMs, 10000);
  for (const snapshot of snapshots) assert.deepEqual(snapshot.reading, priorReading);
  f.time += 300000; const throttled = await usage.requestRead({ reason: 'status' });
  assert.equal(calls, 2); assert.equal(throttled.state, 'backoff'); assert.equal(throttled.nextReadAtMs, f.time + 7200000);
  assert.deepEqual(throttled.reading, priorReading);
  assert.equal(throttled.reading.observedAtMs, observedAtMs);
  const second = createAccountBroker({ store: createAccountStore({ directory: f.directory }), providers: f.providers,
    clock: () => f.time, proxy: f.proxy, authority: f.authority }); t.after(() => second.close());
  const restored = await second.getAccountUsage(account.id).requestRead({ reason: 'admission' });
  assert.equal(calls, 2); assert.equal(restored.ageMs, 310000); assert.equal(restored.nextReadAtMs, throttled.nextReadAtMs);
  assert.equal(restored.state, 'backoff');
  assert.deepEqual(restored.reading, priorReading);
  assert.equal(restored.reading.observedAtMs, observedAtMs);
  assert.equal(parseRetryAfter('7200', f.time), f.time + 7200000);
  assert.equal(parseRetryAfter(new Date(f.time + 7200000).toUTCString(), f.time), f.time + 7200000);
  assert.equal(parseRetryAfter('invalid', f.time), null);
});

test('event replay, delta gaps, cumulative reset, late old epoch and window reset conserve debit', async t => {
  const f = fixture(t); const account = (await f.enroll()).value; const usage = f.broker.getAccountUsage(account.id);
  assert.equal((await usage.ingestJobReading(event(account.id, 2))).value.kind, 'gap');
  assert.equal((await usage.ingestJobReading(event(account.id, 1))).value.lastSequence, 2);
  assert.equal((await usage.ingestJobReading(event(account.id, 2))).value.kind, 'replay');
  assert.equal((await usage.ingestJobReading(event(account.id, 2, 9))).error.code, 'event_conflict');
  assert.equal(usage.snapshot(f.time).jobReadings.reduce((n, e) => n + e.amount.value, 0), 10);
  const cumulative = (sequence, value, epoch = 'epoch-1', instance = 'week-1') => event(account.id, sequence, value,
    { attemptId: 'cumulative', semantics: 'cumulative', meterEpoch: epoch, windowDebits: [{ id: 'week', instance, micro: value }] });
  for (const e of [cumulative(1, 10), cumulative(2, 15), cumulative(3, 2, 'epoch-2', 'week-2'), cumulative(4, 25, 'epoch-1')]) await usage.ingestJobReading(e);
  const events = usage.snapshot(f.time).jobReadings;
  assert.equal(events.reduce((n, e) => n + e.amount.value, 0), 27);
  assert.equal(events.filter(e => e.attemptId === 'cumulative').reduce((n, e) => n + e.windowDebits[0].micro, 0), 17);
  // The normalized feed retains all debits; only L's ledger may subsume proven coverage.
  assert.equal(usage.snapshot(f.time).reading, null);
  assert.equal((await usage.ingestJobReading(event('wrong-account', 3))).error.code, 'invalid_provider_response');
});

test('cancelled waiter detaches without cancelling shared usage; future observation retained as invalid', async t => {
  let release, reads = 0;
  const f = fixture(t, { readUsage: async ({ auth }) => { reads++; await new Promise(r => { release = r; });
    return { kind: 'reading', reading: reading(auth.accountId, f.time + 1) }; } });
  const a = (await f.enroll()).value; const usage = f.broker.getAccountUsage(a.id);
  const cancel = new AbortController();
  const detached = usage.requestRead({ reason: 'status', signal: cancel.signal });
  const shared = usage.requestRead({ reason: 'guard' });
  cancel.abort(new Error('cancelled-waiter'));
  await assert.rejects(detached, /cancelled-waiter/);
  while (!release) await new Promise(r => setImmediate(r));
  release(); const value = await shared;
  assert.equal(reads, 1); assert.equal(value.reading, null); assert.equal(value.state, 'unavailable');
});

test('renew proof never changes binding or exposes a new secret; removal is isolated and idempotent', async t => {
  const f = fixture(t); const a = (await f.enroll()).value; const b = (await f.enroll('claude', 'second')).value;
  f.proxy.revokeStreams = async () => ({ aborted: [], unconfirmed: [] });
  f.broker.getAccountUsage(a.id);
  const key = (await issue(f, a)).value;
  const renewed = await f.broker.renewJobKey({ keyId: key.keyId, leaseProof: { schemaVersion: 1, signedEnvelope: 'synthetic-proof' } });
  assert.deepEqual(Object.keys(renewed.value).sort(), ['expiresAtMs', 'fence', 'keyId']);
  assert.equal((await f.broker.remove(a.id)).ok, true); assert.equal((await f.broker.remove(a.id)).ok, true);
  assert.throws(() => getAccountUsage(a.id), { code: 'account_not_found' });
  assert.equal((await f.broker.proxy.dispatch({ key: key.key, request: request() })).error.code, 'job_key_revoked');
  assert.deepEqual((await f.broker.list()).map(a => a.id), [b.id]);
  const restarted = createAccountBroker({ store: f.store, providers: f.providers, clock: () => f.time, authority: f.authority, proxy: f.proxy });
  t.after(() => restarted.close());
  const bKey = (await issue(f, b)).value;
  assert.equal((await restarted.proxy.dispatch({ key: bKey.key, request: request() })).error.code, 'job_key_invalid');
});

test('cross-broker shared usage reads once; active cadence is two minutes and disabled idle does not read', async t => {
  let calls = 0;
  const f = fixture(t, { readUsage: async () => { calls++; return { kind: 'unavailable', code: 'synthetic' }; } });
  const a = (await f.enroll()).value;
  await f.store.compareAndSwap(a.id, 0, { activeJobCount: 1 });
  const second = createAccountBroker({ store: createAccountStore({ directory: f.directory }), providers: f.providers, clock: () => f.time });
  t.after(() => second.close());
  const [one, two] = await Promise.all([f.broker.getAccountUsage(a.id).requestRead({ reason: 'status' }), second.getAccountUsage(a.id).requestRead({ reason: 'guard' })]);
  assert.equal(calls, 1); assert.equal(one.nextReadAtMs, f.time + 120000); assert.deepEqual(one, two);
  await f.store.compareAndSwap(a.id, 0, { activeJobCount: 0, enabled: false }); f.time += 300000;
  await f.broker.getAccountUsage(a.id).requestRead({ reason: 'idle' }); assert.equal(calls, 1);
});

test('unknown and proven aggregate coverage retain normalized feed for one-time ledger reconciliation', async t => {
  let sequence = 0;
  const f = fixture(t, { readUsage: async ({ auth }) => ({ kind: 'reading', reading: reading(auth.accountId, f.time - 10000,
    ++sequence, sequence === 1 ? { kind: 'unknown' } : { kind: 'proven', throughSequenceByAttempt: { attempt: 1 } }) }) });
  const a = (await f.enroll()).value; const u = f.broker.getAccountUsage(a.id);
  await u.ingestJobReading(event(a.id, 1)); await u.ingestJobReading(event(a.id, 2));
  const unknown = await u.requestRead({ reason: 'admission' });
  assert.equal(unknown.jobReadings.reduce((n, e) => n + e.amount.value, 0), 10);
  f.time += 300000; const proven = await u.requestRead({ reason: 'settlement' });
  const represented = proven.jobReadings.filter(e => e.sequence <= proven.reading.coverage.throughSequenceByAttempt[e.attemptId]).reduce((n, e) => n + e.amount.value, 0);
  const unrepresented = proven.jobReadings.filter(e => e.sequence > proven.reading.coverage.throughSequenceByAttempt[e.attemptId]).reduce((n, e) => n + e.amount.value, 0);
  assert.equal(represented, 5); assert.equal(unrepresented, 5); assert.equal(represented + unrepresented, 10);
  assert.equal(proven.ageMs, 10000);
});

test('reconciliation unavailable keeps intent/backoff; proven unchanged permits exactly one retry', async t => {
  let reconciliations = 0, rotations = 0;
  const f = fixture(t, { refresh: async () => { rotations++; return ok({ secret: { sentinel: 'SYNTHETIC' }, expiresAtMs: 999999999 }); },
    reconcileRotation: async () => ++reconciliations === 1 ? { kind: 'unavailable', retryAtMs: f.time + 1000 } : { kind: 'unchanged' } });
  const a = (await f.enroll()).value;
  await f.store.compareAndSwap(a.id, 0, { refreshIntent: { id: 'uncertain' } });
  assert.equal((await f.broker.withAuth(a.id, async () => {})).error.code, 'refresh_uncertain');
  await f.broker.withAuth(a.id, async () => {}); assert.equal(reconciliations, 1); assert.equal(rotations, 0);
  f.time += 1000; assert.equal((await f.broker.withAuth(a.id, async a => a.generation)).value, 1); assert.equal(rotations, 1);
});

test('safe authorization retry refreshes once; one-shot authorization is never replayed', async t => {
  let authorizations = 0, rotations = 0;
  const f = fixture(t, { authorizeRequest: async ({ request }) => ++authorizations % 2 ?
    { ok: false, error: { code: 'auth_expired' } } : ok({ ...request, headers: { authorization: 'SYNTHETIC' } }),
    classifyReplay: () => 'safe_if_reconstructable', refresh: async () => { rotations++; return ok({ secret: { sentinel: 'SYNTHETIC' }, expiresAtMs: 999999999 }); } });
  const a = (await f.enroll()).value, key = (await issue(f, a)).value;
  const result = await f.broker.proxy.dispatch({ key: key.key, request: request() });
  assert.equal(result.ok, true); await result.value.response.text(); assert.equal(rotations, 1); assert.equal(authorizations, 2);
  const once = await f.broker.proxy.dispatch({ key: key.key, request: request({ body: { kind: 'one_shot', stream: new ReadableStream(), dispose: async () => {} } }) });
  assert.equal(once.error.code, 'auth_expired'); assert.equal(authorizations, 3); assert.equal(rotations, 1);
});

test('one-shot stream is consumed once, disposed once, and cannot be submitted twice', async t => {
  const f = fixture(t); const a = (await f.enroll()).value; const key = (await issue(f, a)).value;
  let consumed = 0, disposed = 0, dispatched = 0;
  const body = { kind: 'one_shot', stream: new ReadableStream({ start(c) { c.enqueue(new Uint8Array([42])); c.close(); } }),
    dispose: async () => { disposed++; } };
  f.proxy.dispatch = async ({ request }) => {
    dispatched++; const reader = request.body.stream.getReader();
    for (;;) { const chunk = await reader.read(); if (chunk.done) break; consumed += chunk.value.length; }
    return ok({ streamId: 'stream', response: new Response('done') });
  };
  const response = await f.broker.proxy.dispatch({ key: key.key, request: request({ body }) });
  await response.value.response.text();
  assert.equal((await f.broker.proxy.dispatch({ key: key.key, request: request({ body }) })).error.code, 'body_already_consumed');
  assert.equal(consumed, 1); assert.equal(disposed, 1); assert.equal(dispatched, 1);
});

test('real child exit after possible rotation leaves intent that denies replay on restart', async t => {
  const f = fixture(t); const a = (await f.enroll()).value;
  await f.store.compareAndSwap(a.id, 0, { expiresAtMs: f.time });
  const source = `import {createAccountStore} from './lib/v1/accounts.mjs';
import {createAccountBroker} from './lib/v1/account-broker.mjs';
import {createFakeRegistry} from './lib/v1/providers/fixtures.mjs';
const b=createAccountBroker({store:createAccountStore({directory:process.argv[1]}),
providers:createFakeRegistry({refresh:async()=>process.exit(23)}),clock:()=>1000000});
await b.withAuth(process.argv[2],async()=>{});`;
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.directory, a.id], { stdio: 'ignore' });
    child.on('error', reject); child.on('exit', resolve);
  });
  assert.equal(code, 23); assert.ok(f.store.get(a.id).refreshIntent);
  assert.equal((await f.broker.withAuth(a.id, async () => {})).error.code, 'reauthorization_required');
  assert.equal(f.store.get(a.id).generation, 0);
});

test('malformed rotation cannot publish a new generation or lose its recovery intent', async t => {
  const f = fixture(t, { refresh: async () => ok({ expiresAtMs: 999999999 }) });
  const a = (await f.enroll()).value; await f.store.compareAndSwap(a.id, 0, { expiresAtMs: f.time });
  assert.equal((await f.broker.withAuth(a.id, async () => {})).error.code, 'invalid_provider_response');
  assert.equal(f.store.get(a.id).generation, 0); assert.ok(f.store.get(a.id).refreshIntent);
});

test('r1 removal keeps reconciliation state on unconfirmed revoke and succeeds only after acknowledgement', async t => {
  const f = fixture(t); const a = (await f.enroll()).value;
  await issue(f, a);
  let confirmed = false;
  f.proxy.revokeStreams = async () => confirmed
    ? { aborted: ['synthetic-upstream'], unconfirmed: [] }
    : { aborted: [], unconfirmed: ['synthetic-upstream'] };
  const pending = await f.broker.remove(a.id);
  assert.equal(pending.ok, false);
  assert.ok(f.store.get(a.id), 'private reconciliation state must survive');
  assert.equal((await issue(f, a)).ok, false, 'removal intent must deny new authority');
  confirmed = true;
  assert.equal((await f.broker.remove(a.id)).ok, true);
  assert.equal(f.store.get(a.id), null);
  assert.equal((await f.broker.remove(a.id)).ok, true);
});

test('r1 a child-process remover cannot report success over an unconfirmed parent stream', async t => {
  const f = fixture(t); const a = (await f.enroll()).value;
  let abortSeen = false;
  f.proxy.dispatch = async ({ signal }) => {
    signal.addEventListener('abort', () => { abortSeen = true; }, { once: true });
    return ok({ streamId: 'parent-live', response: new Response(new ReadableStream({
      pull() { return new Promise(() => {}); }
    })) });
  };
  f.proxy.revokeStreams = async () => ({ aborted: [], unconfirmed: ['parent-live'] });
  const key = (await issue(f, a)).value;
  const live = await f.broker.proxy.dispatch({ key: key.key, request: request() });
  assert.equal(live.ok, true);
  const source = `import {createAccountStore} from './lib/v1/accounts.mjs';
import {createAccountBroker} from './lib/v1/account-broker.mjs';
const b=createAccountBroker({store:createAccountStore({directory:process.argv[1]}),
providers:{getProvider:()=>({ok:false})},
proxy:{revokeStreams:async()=>({aborted:[],unconfirmed:['parent-live']})}});
const r=await b.remove(process.argv[2]);process.stdout.write(JSON.stringify(r));await b.close();`;
  const removed = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source, f.directory, a.id],
      { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', bytes => { output += bytes; });
    child.stderr.on('data', bytes => { errors += bytes; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) { reject(new Error(errors)); return; }
      try { resolve(JSON.parse(output)); } catch (error) { reject(error); }
    });
  });
  assert.equal(removed.ok, false, 'process-local empty key map is not proof of cessation');
  assert.ok(f.store.get(a.id));
  // A repair must additionally prove bounded cancellation acknowledgement for
  // stalled readers; this test deliberately holds transport unconfirmed.
  void abortSeen;
});

test('r1 generation-stale throttle persists full Retry-After through restart', async t => {
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const f = fixture(t, { readUsage: async () => {
    started();
    return new Promise(resolve => { release = resolve; });
  } });
  const a = (await f.enroll()).value, u = f.broker.getAccountUsage(a.id);
  const pending = u.requestRead({ reason: 'status' });
  await entered;
  assert.equal((await f.broker.refreshAuth(a.id)).ok, true);
  const deadline = f.time + 7200000;
  release({ kind: 'throttled', retryAtMs: deadline });
  const result = await pending;
  assert.equal(result.nextReadAtMs, deadline);
  const restarted = createAccountBroker({ store: createAccountStore({ directory: f.directory }),
    providers: f.providers, clock: () => f.time, authority: f.authority, proxy: f.proxy });
  t.after(() => restarted.close());
  assert.equal(restarted.getAccountUsage(a.id).snapshot(f.time).nextReadAtMs, deadline);
});

test('r1 cumulative old replay has no debit; provably conflicting sequence alias is rejected', async t => {
  const f = fixture(t); const a = (await f.enroll()).value;
  const u = f.broker.getAccountUsage(a.id);
  const first = event(a.id, 1, 5, { semantics: 'cumulative' });
  await u.ingestJobReading(first);
  await u.ingestJobReading(event(a.id, 2, 8, { semantics: 'cumulative' }));
  const before = u.snapshot(f.time).jobReadings;
  assert.equal((await u.ingestJobReading(first)).ok, true);
  assert.deepEqual(u.snapshot(f.time).jobReadings, before);
  const conflict = await u.ingestJobReading({ ...first, eventId: 'alias',
    amount: { ...first.amount, value: 9 } });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'event_conflict');
  assert.deepEqual(u.snapshot(f.time).jobReadings, before, 'no invented replay debit');
});

test('r2 stale payloads cannot overwrite fresh generation state', async t => {
  for (const kind of ['reading', 'signed_out']) {
    let started, release;
    const entered = new Promise(resolve => { started = resolve; });
    const f = fixture(t, { readUsage: async () => {
      started(); return new Promise(resolve => { release = resolve; });
    } });
    const a = (await f.enroll()).value, u = f.broker.getAccountUsage(a.id);
    const work = u.requestRead({ reason: 'status' });
    await entered;
    await f.broker.refreshAuth(a.id);
    const fresh = reading(a.id, f.time, 5);
    await f.store.transaction(state => {
      state.records[a.id].usage.reading = fresh;
      state.records[a.id].usage.state = 'ready';
    });
    release(kind === 'reading' ? { kind, reading: reading(a.id, f.time, 6) } : { kind });
    const result = await work;
    assert.deepEqual(result.reading, fresh);
    assert.equal(result.state, 'ready');
    assert.equal(f.store.get(a.id).authState, 'signed_in');
  }
});

test('r2 shared removal cancels a stalled reader and waits for explicit receipt', async t => {
  const f = fixture(t); const a = (await f.enroll()).value;
  let cancelled = false, acknowledged = false;
  f.proxy.dispatch = async () => ok({ streamId: 'stalled',
    response: new Response(new ReadableStream({
      pull() { return new Promise(() => {}); },
      cancel() { cancelled = true; }
    })) });
  f.proxy.revokeStreams = async () => acknowledged
    ? { aborted: ['stalled'], unconfirmed: [] }
    : { aborted: [], unconfirmed: ['stalled'] };
  const key = (await issue(f, a)).value;
  const live = await f.broker.proxy.dispatch({ key: key.key, request: request() });
  const pending = live.value.response.body.getReader().read().then(() => 'data', () => 'revoked');
  const other = createAccountBroker({ store: createAccountStore({ directory: f.directory }),
    providers: f.providers, clock: () => f.time, authority: f.authority, proxy: f.proxy });
  t.after(() => other.close());
  assert.equal((await other.remove(a.id)).ok, false);
  let timer;
  try {
    const result = await Promise.race([pending, new Promise(resolve => {
      timer = setTimeout(() => resolve('timeout'), 3000);
    })]);
    assert.equal(result, 'revoked');
  } finally { clearTimeout(timer); }
  assert.equal(cancelled, true);
  assert.ok(Object.keys(f.store.get(a.id).dispatchOperations).length);
  acknowledged = true;
  assert.equal((await other.remove(a.id)).ok, true);
  assert.equal(f.store.get(a.id), null);
});

import {createLendingLedger} from '../../lib/v1/lending-launch.mjs';
test('durable normalized cumulative jumps and meter resets enter the same ledger once across reopen',async t=>{
 const f=fixture(t),account=(await f.enroll()).value,usage=f.broker.getAccountUsage(account.id);
 const deps={journal:{directory:f.directory+'/launch'},settings:async()=>({revision:1}),nativeUnits:[{id:'tokens',scale:1}],
  usageSource:id=>f.broker.getAccountUsage(id).snapshot(f.time)};
 let ledger=createLendingLedger(deps);
 const amount={unit:'native',nativeUnit:'tokens',byResource:[{id:'tokens',instance:null,amount:100}]};
 const reserved=await ledger.compareAndReserve({accountId:account.id,operationId:'reserve',expectedRevision:0,settingsRevision:1,
  receipt:{accountId:account.id,jobId:'j',attemptId:'normalized-attempt',quotedLedgerRevision:0,settingsRevision:1,amount},enforcement:{amount}});
 assert.equal(reserved.kind,'applied');
 const event=(sequence,value,meterEpoch='first')=>({schemaVersion:1,accountId:account.id,attemptId:'normalized-attempt',eventId:'raw-'+sequence,
  sequence,atMs:f.time,semantics:'cumulative',meterEpoch,amount:{unit:'tokens',value},windowDebits:[]});
 const ingest=async raw=>{assert.equal((await usage.ingestJobReading(raw)).ok,true);
  const result=await ledger.settle({accountId:account.id,reservationId:reserved.value.reservationId,
   operationId:'settle-'+raw.eventId,cessationAtMs:f.time,usage:usage.snapshot(f.time)});assert.equal(result.kind,'applied');};
 await ingest(event(4,20));ledger=createLendingLedger(deps);
 await ingest(event(5,25));await ingest(event(6,3,'second'));
 const snapshot=usage.snapshot(f.time);assert.deepEqual(snapshot.jobReadings.map(e=>[e.sequence,e.amount.value]),[[4,20],[5,5],[6,3]]);
 await ledger.settle({accountId:account.id,reservationId:reserved.value.reservationId,operationId:'repeat',cessationAtMs:f.time,usage:snapshot});
 const row=(await ledger.snapshot(account.id)).resources[0];assert.equal(row.consumed,28);assert.equal(row.reserved,72);
 assert.equal(row.unrepresented,28,'unknown coverage retains debit exposure and unused reservation');
});
