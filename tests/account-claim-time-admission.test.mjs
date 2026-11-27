import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createAccountExecution} from '../lib/v1/account-execution.mjs';
import {createAccountBroker} from '../lib/v1/account-broker.mjs';
import {windowHistoryRows} from '../lib/v1/account-usage.mjs';
import {lagBoundsFor} from '../lib/v1/lending-rule-defaults.mjs';
import {appFixture,api,syntheticBackend,waitFor} from './helpers/v1-app-fixture.mjs';

// Claim or don't claim (design 1119 item 3): every lender-side "can't run this" is decided at claim time.
// A lender that cannot run an account job never claims it, because the account advertisement reads the same
// decideLending answer the launch would; the saved window observations (break 5) calibrate that answer, and a
// no-can-run answer that still arrives after a claim declines with its real reason so the job reopens.

const MICRO = 1000000, HOUR = 3600000;
function record(overrides = {}) {
  return {schemaVersion: 1, id: 'a1', providerId: 'claude', label: 'Test', authState: 'signed_in', generation: 0,
    expiresAtMs: null, enabled: true, modelOrder: [], subjectId: 'subject-1',
    secret: {credential: {access: 'a', refresh: 'r', expires: 4000}, subjectId: 'subject-1'}, refreshIntent: null, ...overrides};
}
function usageSnapshot(overrides = {}) {
  return {schemaVersion: 1, accountId: 'a1', reading: null, jobReadings: [], ageMs: null,
    lastAttemptAtMs: null, nextReadAtMs: null, state: 'unavailable', limitResetAtMs: null, ...overrides};
}
function accountStore(records) {
  const state = {records};
  return {
    read: () => structuredClone(state),
    get: id => structuredClone(state.records[id] ?? null),
    transaction: async fn => fn(state),
    exclusive: async (id, fn) => fn(),
    exclusiveUsage: async (id, fn) => fn(),
    compareAndSwap: async (id, generation, patch) => {
      const current = state.records[id];
      if (!current || current.generation !== generation) return false;
      Object.assign(current, patch);
      return true;
    },
  };
}
const adapter = {
  descriptor: {refreshKind: 'none', usageKind: 'remote', nativeUnits: [{id: 'tokens', scale: 1}], models: []},
};
const providers = {getProvider: () => ({ok: true, value: adapter}), listProviders: () => [adapter]};
function executionFor(store, {policy = {schemaVersion: 1, enabled: true, revision: 1, strategy: 'automatic', strategyParams: {}, protectionPosition: 'keep_more_for_me'}, usage}, t) {
  const directory = mkdtempSync(join(tmpdir(), 'faravan-claim-time-'));
  t?.after(() => rmSync(directory, {recursive: true, force: true}));
  const broker = createAccountBroker({store, clock: Date.now, providers,
    proxy: {dispatch: async () => ({ok: false, error: {code: 'not_used'}})}, authority: {verify: async () => ({ok: false})}});
  if (usage) broker.getAccountUsage = () => ({snapshot: () => usage, requestRead: () => Promise.resolve(usage),
    subscribe: () => () => {}, close: async () => {}});
  return {broker,
    execution: createAccountExecution({directory, store, broker, providers,
      settings: async () => policy, clock: Date.now})};
}

test('lendability answers per account what the launch decision would, without a job', async t => {
  const at = Date.now();
  const store = accountStore({a1: record()});
  const {broker, execution} = executionFor(store, {usage: usageSnapshot({
    state: 'limit', limitResetAtMs: at + 3600000,
    reading: {schemaVersion: 1, accountId: 'a1', observationId: 'x', sequence: at, observedAtMs: at, receivedAtMs: at,
      postingUncertaintyMs: null, windows: [{id: 'seven_day', instance: 'seven_day:1', capacityMicro: 100 * MICRO,
        usedLoMicro: 90 * MICRO, usedHiMicro: 90 * MICRO, resetsAtMs: at + 7 * 86400000, maxOwnerRateMicroPerMs: null}],
      coverage: {kind: 'unknown'}},
  })});
  assert.equal(broker.getAccountUsage('a1').snapshot().accountId, 'a1');
  const decision = await execution.lendability({accountId: 'a1'});
  assert.equal(decision.kind, 'hold');
  assert.equal(decision.code, 'provider_limit_reached');
  assert.deepEqual(decision.nextAction.target, {accountId: 'a1'});
});

test('a signed-out or disabled account is a hold, a lending one is a lend', async t => {
  const at = Date.now();
  const reading = {schemaVersion: 1, accountId: 'a1', observationId: 'x', sequence: at, observedAtMs: at, receivedAtMs: at,
    postingUncertaintyMs: null, windows: [{id: 'seven_day', instance: 'seven_day:1', capacityMicro: 100 * MICRO,
      usedLoMicro: 0, usedHiMicro: 0, resetsAtMs: at + 7 * 86400000, maxOwnerRateMicroPerMs: null}], coverage: {kind: 'unknown'}};
  const usable = usageSnapshot({state: 'ready', reading});
  const fresh = accountStore({a1: record()});
  assert.equal((await executionFor(fresh, {usage: usable}, t).execution.lendability({accountId: 'a1'})).kind, 'lend');
  assert.equal((await executionFor(fresh, {usage: usable, policy: {schemaVersion: 1, enabled: false, revision: 1, strategy: 'automatic', strategyParams: {}, protectionPosition: 'keep_more_for_me'}}, t)
    .execution.lendability({accountId: 'a1'})).code, 'lending_off');
  const signedOut = accountStore({a1: record({authState: 'signed_out'})});
  assert.equal((await executionFor(signedOut, {usage: usable}, t).execution.lendability({accountId: 'a1'})).code, 'account_signed_out');
  assert.equal(await executionFor(accountStore({}), {usage: usable}, t).execution.lendability({accountId: 'missing'}), null);
});

test('saved window observations calibrate the burn-rate bound instead of cold start', () => {
  const now = 3 * HOUR;
  const usage = usageSnapshot({windowHistory: [
    {id: 'seven_day', instance: 'seven_day:1', atMs: HOUR, points: 10},
    {id: 'seven_day', instance: 'seven_day:1', atMs: 2 * HOUR, points: 110},
  ]});
  const rows = windowHistoryRows(usage, now);
  assert.deepEqual(rows, [{window_id: 'seven_day', trace: [[HOUR, 10], [2 * HOUR, 110]]}]);
  const calibrated = lagBoundsFor({windows: [{id: 'seven_day'}], rows, now});
  assert.equal(calibrated.maxPointsPerHour.seven_day, 150, 'margin x highest observed burn (100/h)');
  assert.equal(calibrated.rateProvenance, 'estimated from owner history x1.5 (lead-chosen)');
  const cold = lagBoundsFor({windows: [{id: 'seven_day'}], rows: windowHistoryRows(usageSnapshot(), now), now});
  assert.equal(cold.maxPointsPerHour.seven_day, 20, 'no saved history keeps the cold-start floor');
  assert.equal(cold.rateProvenance, 'cold-start default (lead-chosen)');
});

test('a saved burn history calibrates the estimate where the cold assumption would admit more', async t => {
  const at = Date.now();
  // The regime a fresh account actually lends in: no reading yet, cold accounting. The saved
  // observations are then the only fact that can bound unreported burn.
  const burnHistory = (from, to) => usageSnapshot({state: 'ready',
    windowHistory: [
      {id: 'seven_day', instance: 'seven_day:1', atMs: at - 2 * HOUR, points: from},
      {id: 'seven_day', instance: 'seven_day:1', atMs: at - HOUR, points: to},
    ]});
  const store = accountStore({a1: record()});
  const cold = await executionFor(store, {usage: usageSnapshot({state: 'ready'})}, t)
    .execution.lendability({accountId: 'a1'});
  assert.equal(cold.kind, 'lend', 'no saved history keeps the cold-start floor');
  const slow = await executionFor(accountStore({a1: record()}), {usage: burnHistory(10, 30)}, t)
    .execution.lendability({accountId: 'a1'});
  assert.equal(slow.kind, 'lend');
  assert.ok(slow.amount.byResource[0].amount < cold.amount.byResource[0].amount,
    'a saved 20 points/hour burn lowers the estimate below the cold assumption');
  const fast = await executionFor(accountStore({a1: record()}), {usage: burnHistory(10, 50)}, t)
    .execution.lendability({accountId: 'a1'});
  assert.equal(fast.kind, 'wait', 'a saved 40 points/hour burn holds the account for its owner');
  assert.equal(fast.reason, 'owner_reserve');
});

test('the launch refusal keeps its structured reason, next action and retry time', async t => {
  const at = Date.now();
  const store = accountStore({a1: record()});
  const {broker, execution} = executionFor(store, {usage: usageSnapshot({state: 'limit', limitResetAtMs: at + 3600000})}, t);
  const jobId = 'sha256:' + '0'.repeat(64);
  const attempt = {attempt_id: 'attempt-1', job_digest: jobId, generation: 1};
  const selection = {providerId: 'claude', accountId: 'a1', modelId: 'm', effortId: null};
  await assert.rejects(() => execution.wrap({client: {accountLease: async () => ({proof: {schemaVersion: 1, signedEnvelope: '{}'}})},
    attempt, selection, job: {circle: 'c', requirements: {limits: {wall_seconds: 60}}},
    spec: {}, backend: {}}), error => {
    assert.equal(error.code, 'provider_limit_reached');
    assert.equal(error.admissionDecline, true);
    assert.deepEqual(error.nextAction, {id: 'wait_for_reset', label: 'Wait until allowance resets',
      target: {accountId: 'a1', jobId}});
    return true;
  });
  await execution.close();
});

// The whole claim-time rule at app level: an account at its provider limit is not offered, so the signed job
// waits in the queue with its honest reason instead of being claimed and failing; a fresh account takes it.
const providerConfiguration = {
  descriptor: {schemaVersion: 1, id: 'codex', label: 'Configured key service', signInKind: 'api_key', refreshKind: 'none',
    usageKind: 'job_local', maxConcurrentJobs: 1, nativeUnits: [{id: 'tokens', scale: 1}],
    models: [{id: 'example-model', label: 'Example', enabled: true, rank: 0, pareto: null,
      efforts: [{id: 'high', label: 'High'}], defaultEffort: 'high'}],
    destinations: [{origin: 'https://controlled.invalid', pathPrefixes: ['/v1'], methods: ['POST']}]},
  identityUrl: 'https://controlled.invalid/me', identitySubjectField: 'subject', command: 'codex', args: ['exec'],
  modelFlag: '-m', effortFlag: '--effort', keyEnv: 'JOB_KEY', baseUrlEnv: 'BASE_URL',
};
async function enroll(app, key, operationId) {
  const flow = await api(app, '/api/accounts', {method: 'POST', body: {providerId: 'codex', label: operationId, operationId}});
  const account = (await api(app, '/api/accounts/flows/' + flow.value.flowId + '/complete', {method: 'POST', body: {answer: key}})).value;
  const {revision} = await api(app, '/api/accounts');
  const settings = await api(app, '/api/accounts/' + account.id + '/settings', {method: 'POST',
    body: {expectedRevision: revision, modelPreference: {modelId: 'example-model', enabled: true, effortIds: null}}});
  assert.equal(settings.ok, true, JSON.stringify(settings));
  return account;
}

async function signedClaimTimeAdmission(t, {useSecondAccount = false} = {}) {
  const f = await appFixture(t);
  const backend = syntheticBackend(f.root);
  backend.prepareAccountRun = async spec => {
    const h = await backend.prepare(spec);
    h.job_id = spec.job_id; h.sandbox_id = 'claim-' + randomUUID(); h._cleanupId = randomUUID();
    return h;
  };
  backend.inspect = async h => ({job_id: h.job_id, status: 'exited'});
  const originalStart = backend.start.bind(backend);
  backend.start = async (h, opts) => {
    if (h._entrypoint.startsWith('env ')) {
      const key = /JOB_KEY=([^']+)/.exec(h._entrypoint)?.[1];
      const base = /BASE_URL=([^']+)/.exec(h._entrypoint)?.[1];
      const response = await fetch(base + '/responses', {method: 'POST',
        headers: {authorization: 'Bearer ' + key, 'content-type': 'application/json'},
        body: JSON.stringify({model: 'example-model', effort: 'high'})});
      assert.equal(response.status, 200);
      h._entrypoint = 'completed-claim-time';
    }
    return originalStart(h, opts);
  };
  let fakeIdentitySubject = 'claim-time-account-first';
  const {owner, lender, circle, realHeartbeats} = await f.realConnect({lenderOptions: {
    backend, accountProviderConfigurations: [providerConfiguration],
    accountTransportFetch: async (_url, options) => {
      if (options.method === 'GET') return Response.json({subject: fakeIdentitySubject});
      return Response.json({id: 'claim-response', object: 'response', status: 'completed', model: 'example-model'});
    },
  }});
  const account = await enroll(lender.app, 'CLAIM_TIME_ACCOUNT', 'claim-enroll');
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false}});
  await api(lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  const mode = await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  assert.ok(mode.standingRules.some(rule => rule.circle === circle.id), 'audited standing rule covers this circle');
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await waitFor(() => realHeartbeats.filter(row => row.device === lender.app.device.keyId)
    .at(-1)?.body.accounts?.some(row => row.accountId === account.id), 'published account before the limit', 30000);

  // The account reaches its provider limit: the claim-time answer must stop offering it.
  const storeFile = join(lender.home, 'v1', 'accounts', 'accounts.json');
  const limitAt = Date.now();
  const store = JSON.parse(readFileSync(storeFile, 'utf8'));
  store.records[account.id].usage = {reading: null, jobReadings: [], events: {}, meters: {}, pending: {},
    windowHistory: [], lastAttemptAtMs: null, nextReadAtMs: null, state: 'limit',
    limitResetAtMs: limitAt + 3600000, failures: 0, readLease: null};
  writeFileSync(storeFile, JSON.stringify(store));
  await waitFor(() => {
    const rows = realHeartbeats.filter(row => row.device === lender.app.device.keyId);
    const accounts = rows.at(-1)?.body.accounts ?? [];
    return !accounts.some(row => row.accountId === account.id);
  }, 'the limited account leaves the claim advertisement', 30000);

  const submitted = await api(owner.app, '/api/jobs', {method: 'POST', body: {
    circle: circle.id, prompt: 'Signed job nobody can run yet',
    git: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40), harness: 'codex',
    runRequest: {schemaVersion: 1, models: [{providerId: 'codex', modelId: 'example-model'}], effortId: 'high'},
  }});
  const client = await owner.app.device.client(circle.id);
  // No lender that can run it: the job stays queued, it is never claimed and never failed.
  await new Promise(resolve => setTimeout(resolve, 12000));
  let view = await client.getJob(submitted.jobDigest);
  assert.equal(view.state, 'queued', 'no claim happens while no offered account can run the request');
  assert.equal(view.current_attempt, null);

  let selectedAccountId = account.id;
  if (useSecondAccount) {
    fakeIdentitySubject = 'claim-time-account-second';
    const second = await enroll(lender.app, 'CLAIM_TIME_ACCOUNT_SECOND', 'claim-enroll-second');
    assert.notEqual(second.id, account.id, 'the injected provider enrolled a distinct account');
    selectedAccountId = second.id;
    await waitFor(() => {
      const accounts = realHeartbeats.filter(row => row.device === lender.app.device.keyId)
        .at(-1)?.body.accounts ?? [];
      return accounts.some(row => row.accountId === second.id) && !accounts.some(row => row.accountId === account.id);
    }, 'the new account, not the limited account, is advertised', 30000);
  } else {
    // Preserve the single-account reset/recovery control.
    const reset = JSON.parse(readFileSync(storeFile, 'utf8'));
    reset.records[account.id].usage = {reading: null, jobReadings: [], events: {}, meters: {}, pending: {},
      windowHistory: [], lastAttemptAtMs: null, nextReadAtMs: null, state: 'unavailable',
      limitResetAtMs: null, failures: 0, readLease: null};
    writeFileSync(storeFile, JSON.stringify(reset));
  }
  view = await waitFor(async () => (await client.getJob(submitted.jobDigest)).state === 'result-accepted'
    ? await client.getJob(submitted.jobDigest) : null, 'the job runs once a lender can run it again', 60000);
  const result = await client.fetchResult(submitted.jobDigest, {includeMetadata: true, attempt: view.current_attempt});
  assert.deepEqual(result.receipt.selection, {providerId: 'codex', accountId: selectedAccountId, modelId: 'example-model', effortId: 'high'});
}

test('an account at its provider limit is not offered, and its signed job waits instead of failing', {timeout: 180000}, t => signedClaimTimeAdmission(t));

test('the signed job result names the second account when the first remains limited', {timeout: 180000}, t => {
  return signedClaimTimeAdmission(t, {useSecondAccount: true});
});
