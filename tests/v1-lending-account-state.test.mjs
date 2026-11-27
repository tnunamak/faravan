import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createLender} from '../lib/v1/lender.mjs';
import {createIdentityPinStore} from '../lib/v1/lending-identity-pin.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {createMockUsage} from './helpers/mock-usage.mjs';

// A second account of one provider is keyed `provider:<uuid>`; the first account keeps the bare provider name.
const OTHER = 'claude:12345678-1234-4123-8123-123456789abc';
const NOW = Date.parse('2026-10-23T06:40:00Z');
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: null, budget_v1: {max_list_usd: 4}};
// Directories outlive each test's own cleanup (an adapter closes after its test); the file removes them all at the end.
const made = [];
test.after(() => { for (const d of made) fs.rmSync(d, {recursive: true, force: true}); });
const dir = () => { const d = fs.mkdtempSync(join(tmpdir(), 'account-state-')); made.push(d); return d; };

// ---- pool workers ----

function poolWith(rows, {slots = 1} = {}) {
  const created = [], holds = [];
  const child = options => {
    const row = {options, admits: 0, refreshes: 0};
    created.push(row);
    return {start: () => new Promise(() => {}), getState: () => ({status: 'waiting_for_sandbox', reason: 'agent_not_chosen', label: 'x', current: null}),
      admits: () => { row.admits++; return null; }, refreshAdmission: () => { row.refreshes++; }, reconfigure() {}, pause() {}, resume() {},
      cessation: () => ({proven: true})};
  };
  let stored = {jobs: 0, milliseconds: 0, pending: null, accounts: rows};
  const storage = {get: async () => structuredClone(stored), set: async next => { stored = structuredClone(next); }};
  const pool = createLendingPool({storage, capacity: 3, maxResources: {cpu: 8, memoryBytes: 64 * 1024 ** 3},
    policy: {enabled: true, lendingPolicy: {accountSlots: slots}, hold: (_job, context) => { holds.push(context); return null; }},
    adapters: [{spec: {harness_id: 'claude-code-subscription'}}], createLender: child});
  return {pool, created, holds, stored: () => stored};
}

test('a pool worker knows the whole key of the account it serves, and the legacy key keeps its stored id', async () => {
  const {pool, created, holds} = poolWith({'claude:0': {jobs: 0, milliseconds: 0}, [OTHER + '#0']: {jobs: 0, milliseconds: 0}});
  pool.start();
  await until(() => created.length === 2, 'two workers');
  const byKey = Object.fromEntries(created.map(row => [row.options.accountKey, row]));
  assert.deepEqual(Object.keys(byKey).sort(), ['claude', OTHER].sort());
  for (const row of created) {
    await row.options.policy.hold({}, {attemptId: 'a'});
  }
  assert.deepEqual(holds.map(({provider, accountKey}) => [provider, accountKey]).sort(),
    [['claude', 'claude'], ['claude', OTHER]].sort(), 'the hold hook is told the provider and the whole key');
  const states = pool.getState().accountStates.map(s => s.account).sort();
  assert.deepEqual(states, ['claude:0', OTHER + '#0'].sort(), 'the legacy worker is still reported as claude:0');
});

test('a worker of a scoped key counts against the slot limit by its slot, never by splitting the key', async () => {
  const {pool, created} = poolWith({[OTHER + '#0']: {jobs: 0, milliseconds: 0}, [OTHER + '#1']: {jobs: 0, milliseconds: 0}}, {slots: 1});
  pool.start();
  await until(() => created.length === 3, 'three workers');
  const second = created.find(row => row.options.accountKey === OTHER && row.options.policy.hold !== undefined &&
    created.filter(r => r.options.accountKey === OTHER).indexOf(row) === 1);
  assert.equal(await second.options.policy.hold({}, {}), 'account_slots', 'slot 1 is over a limit of one');
  assert.equal(pool.admits({requirements: {limits: {}}}), null);
  await pool.refreshAdmission();
  assert.equal(created.filter(r => r.options.accountKey === OTHER).reduce((n, r) => n + r.refreshes, 0), 1,
    'only the worker inside the slot limit re-proves its availability');
  assert.equal(created.find(r => r.options.accountKey === 'claude').refreshes, 1);
});

// ---- the runtime ----

function keyedSource(keys) {
  const base = createSyntheticPace50Source({start: NOW});
  const calls = [];
  return {calls, source: {...base, observe: async args => {
    calls.push(args.accountKey ?? args.provider);
    return keys.has(args.accountKey ?? args.provider) ? base.observe({...args, accountKey: undefined}) : null;
  }}};
}

function runtimeWith(t, {readOverride, settings = {}, source = createSyntheticPace50Source({start: NOW})} = {}) {
  const directory = dir();
  const runtime = createLendingRuntime({directory, settings: () => settings, backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => NOW, readOverride,
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  t.after(() => runtime.close());
  return runtime;
}
const windowsReading = marker => ({plan: 'unknown', windows: [{window_id: 'seven_day', window_minutes: 10080, used_pct: 10,
  resets_at: NOW + 3600e3, observed_at: NOW, state: 'open', marker}]});

test('readings are asked for by whole account key and never answered from another key', async t => {
  const mock = createMockUsage([['claude', [windowsReading('first')]], [OTHER, [windowsReading('other')]]]);
  const {source, calls} = keyedSource(new Set(['claude']));
  const runtime = runtimeWith(t, {readOverride: mock.readOverride, source});
  assert.equal((await runtime.readings('claude')).windows[0].marker, 'first');
  assert.equal((await runtime.readings(OTHER)).windows[0].marker, 'other');
  assert.deepEqual(mock.calls.map(call => call.accountKey), ['claude', OTHER]);
  const unscripted = 'claude:99999999-9999-4999-8999-999999999999';
  const read = await runtime.readings(unscripted);
  assert.equal(read, null, 'a scoped key with no scripted reading answers nothing, not a provider-level reading');
  assert.deepEqual(calls.filter(key => key === unscripted), [], 'no source is asked for the unknown scoped key: ' + calls);
});

test('a bare provider with no override reading still falls back to its candidate source, normal and forced', async t => {
  // The bare key is a legacy key, not a scoped one: an empty injected read must not turn its fallback into null.
  for (const provider of ['claude', 'codex']) {
    const {source, calls} = keyedSource(new Set(['claude', 'codex']));
    const runtime = runtimeWith(t, {readOverride: createMockUsage([]).readOverride, source});
    const normal = await runtime.readings(provider);
    assert.ok(normal && Array.isArray(normal.windows) && normal.windows.length > 0, provider + ' normal read falls back to the source: ' + JSON.stringify(normal));
    assert.ok(calls.includes(provider), provider + ' normal read asked the source for the bare key: ' + calls);
    const forced = await runtime.readings(provider, {forceRefresh: true});
    assert.ok(forced && Array.isArray(forced.windows) && forced.windows.length > 0, provider + ' forced read falls back to the source: ' + JSON.stringify(forced));
  }
});

test('capacity refresh accepts a scoped key, holds on it, and leaves the first account\'s state alone', async t => {
  const mock = createMockUsage([]);
  const {source, calls} = keyedSource(new Set(['claude']));
  const runtime = runtimeWith(t, {readOverride: mock.readOverride, source});
  const decision = await runtime.refreshCapacity(OTHER);
  assert.ok(calls.length > 0 && calls.every(key => key === OTHER), 'only the key asked about was read: ' + calls);
  assert.equal(decision.admitted, false);
  assert.equal(runtime.candidate.lastJobDecisionFor('claude'), null);
  await assert.rejects(runtime.refreshCapacity('gemini'), TypeError);
});

test('a scoped key inherits no consent from its provider\'s settings', async t => {
  const settings = {limits: {lendingPolicy: {accountPlans: {claude: 'max20'}, providerConsent: {claude: true}}}};
  const runtime = runtimeWith(t, {settings});
  const grant = await runtime.candidate.reserve({attemptId: 'other-1', jobId: 'job-other-1', provider: 'claude', accountKey: OTHER,
    model: 'claude-haiku-5-5', job, automatic: true, ownerAbsent: true});
  assert.equal(grant.ok, false, 'automatic lending on a new key is held: no consent was given for it');
  const first = await runtime.candidate.reserve({attemptId: 'first-1', jobId: 'job-first-1', provider: 'claude',
    model: 'claude-haiku-5-5', job, automatic: true, ownerAbsent: true});
  assert.equal(first.ok, true, JSON.stringify(first));
});

// ---- admission on the account that will run the job ----

const reserve = (candidate, extra = {}) => candidate.reserve({attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude',
  model: 'claude-haiku-5-5', job, automatic: true, ownerAbsent: true, ...extra});

test('a job for one account is never admitted on another account\'s headroom', async t => {
  const {source, calls} = keyedSource(new Set(['claude']));
  const opened = createPace50Candidate({directory: dir(), now: () => NOW, account: 'synthetic-account', account_week_id: 'synthetic-week-1', source});
  t.after(() => opened.adapter.close());
  const refused = await reserve(opened.candidate, {accountKey: OTHER});
  assert.equal(refused.ok, false, JSON.stringify(refused));
  // A scoped reservation is refused before any reading: the legacy account's reading is never used in its place.
  assert.ok(!calls.includes('claude'), 'no reading of the legacy account is taken for the scoped key: ' + calls);
  assert.equal(opened.adapter.state().attempts.length, 0);
  assert.equal(opened.candidate.lastJobDecisionFor('claude'), null, 'the first account\'s last decision is untouched');
  assert.equal(opened.candidate.lastJobDecisionFor(OTHER).admitted, false);
});

test('a scoped-key reservation with headroom is held in the candidate path: the ledger cannot keep accounts apart yet', async t => {
  const {source} = keyedSource(new Set(['claude', OTHER]));
  const opened = createPace50Candidate({directory: dir(), now: () => NOW, account: 'synthetic-account', account_week_id: 'synthetic-week-1', source});
  t.after(() => opened.adapter.close());
  const held = await reserve(opened.candidate, {accountKey: OTHER});
  assert.equal(held.ok, false, JSON.stringify(held));
  assert.equal(held.policyReason, 'account_ledger_unisolated');
  assert.equal(held.reason, 'account_ledger_unisolated');
  assert.equal(opened.adapter.state().attempts.length, 0, 'no durable attempt is written for the scoped key');
  assert.equal(opened.candidate.lastJobDecisionFor(OTHER).admitted, false);
  assert.equal(opened.candidate.lastJobDecisionFor('claude'), null);
  // The first account is unaffected by the refusal of the second.
  const first = await reserve(opened.candidate, {attemptId: 'first-1', jobId: 'job-first-1'});
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.deepEqual(first.reservation, {provider: 'claude', attemptId: 'first-1', model: 'claude-haiku-5-5'});
});

// ---- both reserve branches in the lender ----

function launch(f, accountKey) {
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: event => { f.events.push(event); }, ...(accountKey ? {accountKey} : {})});
  const running = lender.start(controller.signal);
  const settled = Promise.resolve(running).catch(() => {});
  f.stop = async () => { controller.abort(); await settled; };
  return lender;
}

for (const [name, accountKey] of [['the first account', undefined], ['another account', OTHER]]) {
  test(`the durable candidate branch of ${name} is given the key for the gate and the reservation`, {timeout: 60000}, async t => {
    const seen = [];
    const opened = createPace50Candidate({directory: dir(), now: () => f0.clock.now(), account: 'synthetic-account', account_week_id: 'synthetic-week-1',
      source: createSyntheticPace50Source({start: NOW})});
    t.after(() => opened.adapter.close());
    const spy = Object.create(opened.candidate);
    for (const method of ['gate', 'reserve']) spy[method] = async args => { seen.push([method, args]); return method === 'gate' ? null : {ok: false, reason: 'quota_reserve'}; };
    var f0 = await lenderFixture(t, {policy: {mode: 'auto'}, harness: 'claude-code-subscription'});
    f0.adapters[0].run = {model: 'claude-haiku-5-5'};
    f0.policy.userActive = async () => false;
    f0.policy.lendingRuntime = {candidate: spy, effortMax: () => 'high', reserve: async () => { throw new Error('wrong branch'); }};
    launch(f0, accountKey);
    await until(() => seen.some(([m]) => m === 'reserve'), 'a reservation was asked for');
    await f0.stop();
    for (const [, args] of seen) {
      if (accountKey) assert.equal(args.accountKey, OTHER); else assert.equal(Object.hasOwn(args, 'accountKey'), false);
    }
  });
}

// ---- pins ----

test('identity pins of two keys of one provider never read or clear each other', t => {
  const pins = createIdentityPinStore({directory: dir(), now: () => NOW});
  const a = {account_sha256_16: '1111222233334444'}, b = {account_sha256_16: '9999888877776666'};
  assert.deepEqual(pins.expected('claude', a), a);
  assert.deepEqual(pins.expected(OTHER, b), b);
  assert.deepEqual(pins.peek('claude'), a);
  pins.clear(OTHER);
  assert.deepEqual(pins.peek('claude'), a);
  assert.equal(pins.peek(OTHER), null);
});

// ---- the fake usage source is a startup dependency of tests only ----

test('no product code can reach scripted readings from a setting, an environment variable or a request', () => {
  const offenders = [];
  const walk = d => { for (const e of fs.readdirSync(d, {withFileTypes: true})) {
    const p = join(d, e.name);
    if (e.isDirectory()) { if (!['node_modules', 'tests', '.git'].includes(e.name)) walk(p); }
    else if (/\.(mjs|js|jsx)$/.test(e.name) && /mock-usage/.test(fs.readFileSync(p, 'utf8'))) offenders.push(p);
  } };
  for (const d of ['lib', 'bin', 'public', 'tray']) if (fs.existsSync(new URL('../' + d, import.meta.url))) walk(new URL('../' + d, import.meta.url).pathname);
  assert.deepEqual(offenders, []);
});
