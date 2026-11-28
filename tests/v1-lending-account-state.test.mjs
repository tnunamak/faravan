import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingPool} from '../lib/v1/lending-pool.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';

import {createLender} from '../lib/v1/lender.mjs';
import {createIdentityPinStore} from '../lib/v1/lending-identity-pin.mjs';
import {until} from "./helpers/v1-lender-fixture.mjs";
import {createMockUsage} from './helpers/mock-usage.mjs';

// A second account of one provider is keyed `provider:<uuid>`; the first account keeps the bare provider name.
const OTHER = 'claude:12345678-1234-4123-8123-123456789abc';
const NOW = Date.parse('2026-10-23T06:40:00Z');

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
    return {start: () => new Promise(() => {}), getState: () => ({status: 'waiting_for_sandbox', reason: 'lending_off', label: 'x', current: null}),
      admits: () => { row.admits++; return null; }, refreshAdmission: () => { row.refreshes++; }, reconfigure() {}, pause() {}, resume() {},
      cessation: () => ({proven: true})};
  };
  let stored = {jobs: 0, milliseconds: 0, pending: null, accounts: rows};
  const storage = {get: async () => structuredClone(stored), set: async next => { stored = structuredClone(next); }};
  const pool = createLendingPool({storage, capacity: 3, maxResources: {cpu: 8, memoryBytes: 64 * 1024 ** 3},
    policy: {enabled: true, lendingPolicy: {accountSlots: slots}, observeLending: (_job, context) => { holds.push(context); return {waits:[]}; }},
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
    await row.options.policy.observeLending({});
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
  const second = created.find(row => row.options.accountKey === OTHER && row.options.policy.observeLending !== undefined &&
    created.filter(r => r.options.accountKey === OTHER).indexOf(row) === 1);
  assert.deepEqual((await second.options.policy.observeLending({})).waits.map(w=>w.reason),['conditions_unavailable'],'slot 1 is over a limit of one');
  assert.equal(pool.admits({requirements: {limits: {}}}), null);
  await pool.refreshAdmission();
  assert.equal(created.filter(r => r.options.accountKey === OTHER).reduce((n, r) => n + r.refreshes, 0), 1,
    'only the worker inside the slot limit re-proves its availability');
  assert.equal(created.find(r => r.options.accountKey === 'claude').refreshes, 1);
});

// ---- the runtime ----

function runtimeWith(t,{readOverride,settings={}}={}) {
  const runtime=createLendingRuntime({settings:()=>settings,readOverride,now:()=>NOW,presence:()=>false});
  t.after(()=>runtime.close());return runtime;
}
const windowsReading = marker => ({plan: 'unknown', windows: [{window_id: 'seven_day', window_minutes: 10080, used_pct: 10,
  resets_at: NOW + 3600e3, observed_at: NOW, state: 'open', marker}]});

test('readings are asked for by whole account key and never answered from another key', async t => {
  const mock = createMockUsage([['claude', [windowsReading('first')]], [OTHER, [windowsReading('other')]]]);
  const runtime = runtimeWith(t, {readOverride: mock.readOverride});
  assert.equal((await runtime.readings('claude')).windows[0].marker, 'first');
  assert.equal((await runtime.readings(OTHER)).windows[0].marker, 'other');
  assert.deepEqual(mock.calls.map(call => call.accountKey), ['claude', OTHER]);
  const unscripted = 'claude:99999999-9999-4999-8999-999999999999';
  const read = await runtime.readings(unscripted);
  assert.equal(read, null, 'a scoped key with no scripted reading answers nothing, not a provider-level reading');
});



// ---- admission on the account that will run the job ----

// ---- both reserve branches in the lender ----

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
