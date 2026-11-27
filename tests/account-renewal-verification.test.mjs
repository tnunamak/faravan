import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativeHostProviders} from '../lib/v1/providers/native-host.mjs';
import {createAccountBroker} from '../lib/v1/account-broker.mjs';
import {createAccountUsage} from '../lib/v1/account-usage.mjs';

// A renewed Claude sign-in must survive a throttled profile read: the credential is kept privately and its
// identity is verified under the account's shared usage schedule (the one reader that owns provider backoff).
// An auth refusal or a proven different subject still ends the enrollment. D5 break 2.

const credential = (expires, refresh = 'refresh-' + expires) => ({access: 'access-' + expires, refresh, expires});
const validCredential = credential(4000);

function driver({refreshResponse}) {
  return {
    auth: {oauth: {
      login: async () => {throw Error('not used');},
      refresh: async () => refreshResponse,
    }},
    getModels: () => [{id: 'claude-sonnet-4-6', name: 'Sonnet'}],
  };
}

function scriptedFetch({identity = {}, usage = {}} = {}) {
  const calls = [];
  return {
    calls,
    fetch: async (url, options = {}) => {
      calls.push({url: String(url), status: options});
      if (String(url).endsWith('/api/oauth/profile')) {
        const reply = identity;
        if (reply.throw) throw Error('transport_down');
        return new Response(reply.body ?? JSON.stringify({account: {uuid: reply.subject ?? 'subject-1'}}),
          {status: reply.status ?? 200, headers: reply.headers ?? {}});
      }
      if (String(url).endsWith('/api/oauth/usage')) {
        const reply = usage;
        if (reply.throw) throw Error('transport_down');
        if (reply.body) return new Response(reply.body, {status: reply.status ?? 200, headers: reply.headers ?? {}});
        return new Response(JSON.stringify({
          five_hour: {utilization: 0.1, resets_at: Date.now() + 3600000},
          seven_day: {utilization: 0.2, resets_at: Date.now() + 7 * 86400000},
          extra_usage: {is_enabled: false},
        }), {status: reply.status ?? 200});
      }
      throw Error('unexpected url ' + url);
    },
  };
}

const providersFor = (fetch, oauth) => createNativeHostProviders({
  proxyOrigin: () => 'http://127.0.0.1:1', fetch: fetch.fetch, drivers: {claude: oauth}});

test('a throttled profile read keeps the renewed sign-in privately with a pending identity verification', async () => {
  const wire = scriptedFetch({identity: {status: 429, headers: {'retry-after': '120'}}});
  const [claude] = providersFor(wire, driver({refreshResponse: credential(4000, 'rotated-1')}));
  const result = await claude.refresh({secret: {credential: validCredential, subjectId: 'subject-1'}, signal: undefined});
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.subjectVerificationPending, true);
  assert.equal(result.value.secret.subjectId, 'subject-1', 'the retained subject stays private');
  assert.equal(result.value.secret.credential.refresh, 'rotated-1', 'the renewed credential is kept');
});

test('a refused profile read still refuses the rotation', async () => {
  const wire = scriptedFetch({identity: {status: 401}});
  const [claude] = providersFor(wire, driver({refreshResponse: credential(4000, 'rotated-2')}));
  const result = await claude.refresh({secret: {credential: validCredential, subjectId: 'subject-1'}});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'refresh_uncertain');
});

test('a profile read that proves a different subject still refuses the rotation', async () => {
  const wire = scriptedFetch({identity: {subject: 'subject-2'}});
  const [claude] = providersFor(wire, driver({refreshResponse: credential(4000, 'rotated-3')}));
  const result = await claude.refresh({secret: {credential: validCredential, subjectId: 'subject-1'}});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'refresh_uncertain');
});

test('a scheduled usage read verifies the pending identity and reports it', async () => {
  const wire = scriptedFetch({identity: {subject: 'subject-1'}});
  const [claude] = providersFor(wire, driver({refreshResponse: credential(4000, 'rotated-4')}));
  const outcome = await claude.readUsage({auth: {accountId: 'a1', generation: 1,
    secret: {credential: validCredential, subjectId: 'subject-1'}, subjectVerificationPending: true}});
  assert.equal(outcome.kind, 'reading');
  assert.equal(outcome.subjectVerified, true);
});

test('a scheduled read that finds a different subject ends the enrollment', async () => {
  const wire = scriptedFetch({identity: {subject: 'subject-2'}});
  const [claude] = providersFor(wire, driver({refreshResponse: credential(4000, 'rotated-5')}));
  const outcome = await claude.readUsage({auth: {accountId: 'a1', generation: 1,
    secret: {credential: validCredential, subjectId: 'subject-1'}, subjectVerificationPending: true}});
  assert.equal(outcome.kind, 'signed_out');
});

test('a throttled identity check inside the read joins the account-wide backoff', async () => {
  const wire = scriptedFetch({identity: {status: 429, headers: {'retry-after': '60'}}});
  const [claude] = providersFor(wire, driver({refreshResponse: credential(4000, 'rotated-6')}));
  const outcome = await claude.readUsage({auth: {accountId: 'a1', generation: 1,
    secret: {credential: validCredential, subjectId: 'subject-1'}, subjectVerificationPending: true}});
  assert.equal(outcome.kind, 'throttled');
  assert.equal(Number.isSafeInteger(outcome.retryAtMs), true);
});

// The broker and its shared usage reader: the pending flag persists with the rotation, the scheduled read
// clears it once the identity is proven, and the account stays signed_in the whole time.
function accountStore(records) {
  const state = {records};
  return {
    read: () => structuredClone(state),
    get: id => structuredClone(state.records[id] ?? null),
    transaction: async fn => fn(state),
    exclusive: async (id, fn) => fn(),
    exclusiveUsage: async (id, fn) => fn(),
    compareAndSwap: async (id, generation, patch) => {
      const record = state.records[id];
      if (!record || record.generation !== generation) return false;
      Object.assign(record, patch);
      return true;
    },
  };
}

function fakeAdapter({refresh, readUsage}) {
  return {
    descriptor: {refreshKind: 'rotating', usageKind: 'remote', nativeUnits: [{id: 'tokens', scale: 1}], models: []},
    refresh, readUsage,
  };
}

const brokerFor = (store, adapter) => createAccountBroker({store, clock: Date.now,
  providers: {getProvider: () => ({ok: true, value: adapter})},
  proxy: {dispatch: async () => ({ok: false, error: {code: 'not_used'}})},
  authority: {verify: async () => ({ok: false})}});

function record(pending) {
  return {schemaVersion: 1, id: 'a1', providerId: 'claude', label: 'Test', authState: 'signed_in', generation: 0,
    expiresAtMs: 0, enabled: true, modelOrder: [], subjectId: 'subject-1',
    secret: {credential: validCredential, subjectId: 'subject-1'}, refreshIntent: null,
    ...(pending ? {subjectVerificationPending: true} : {})};
}

test('the broker keeps a renewed rotation pending and the shared scheduled read clears it', async () => {
  let clockMs = 1000;
  const store = accountStore({a1: record(true)});
  let readCalls = 0;
  const adapter = fakeAdapter({
    refresh: async () => ({ok: true, value: {secret: {credential: credential(4000, 'rotated-b'), subjectId: 'subject-1'},
      expiresAtMs: 4000, subjectVerificationPending: true}}),
    readUsage: async ({auth}) => {
      readCalls++;
      assert.equal(auth.subjectVerificationPending, true, 'the reader sees the pending flag through withAuth');
      return {kind: 'reading', subjectVerified: true, reading: {schemaVersion: 1, accountId: 'a1',
        observationId: 'a1:' + clockMs, sequence: clockMs, observedAtMs: clockMs, receivedAtMs: clockMs,
        postingUncertaintyMs: null, windows: [{id: 'seven_day', instance: 'seven_day:1', capacityMicro: 100000000,
        usedLoMicro: 0, usedHiMicro: 0, resetsAtMs: clockMs + 604800000, maxOwnerRateMicroPerMs: null}],
        coverage: {kind: 'unknown'}}};
    },
  });
  const broker = brokerFor(store, adapter);
  const refreshed = await broker.refreshAuth('a1');
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.equal(store.get('a1').subjectVerificationPending, true, 'the rotation persists the pending flag');
  assert.equal(store.get('a1').secret.credential.refresh, 'rotated-b', 'the renewed sign-in was kept privately');

  const reader = broker.getAccountUsage('a1');
  const snapshot = await reader.requestRead();
  assert.equal(readCalls, 1);
  assert.equal(snapshot.state, 'ready');
  assert.equal(store.get('a1').subjectVerificationPending, undefined, 'the proven identity retires the flag');
  await reader.close();
});

test('a pending identity that the scheduled read finds changed signs the account out', async () => {
  const store = accountStore({a1: record(true)});
  const adapter = fakeAdapter({
    refresh: async () => ({ok: true, value: {secret: {credential: credential(4000, 'rotated-c'), subjectId: 'subject-1'},
      expiresAtMs: 4000, subjectVerificationPending: true}}),
    readUsage: async () => ({kind: 'signed_out'}),
  });
  const broker = brokerFor(store, adapter);
  const reader = broker.getAccountUsage('a1');
  const snapshot = await reader.requestRead();
  assert.equal(snapshot.state, 'signed_out');
  assert.equal(store.get('a1').authState, 'signed_out');
  await reader.close();
});

test('a rotation that proves its subject explicitly clears a stale pending flag', async () => {
  const store = accountStore({a1: record(true)});
  const adapter = fakeAdapter({
    refresh: async () => ({ok: true, value: {secret: {credential: credential(4000, 'rotated-d'), subjectId: 'subject-1'},
      expiresAtMs: 4000}}),
  });
  const broker = brokerFor(store, adapter);
  const refreshed = await broker.refreshAuth('a1');
  assert.equal(refreshed.ok, true, JSON.stringify(refreshed));
  assert.equal(store.get('a1').subjectVerificationPending, false, 'a verified rotation writes an explicit false');
});
