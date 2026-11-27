import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createLender} from '../lib/v1/lender.mjs';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {appFixture, api, syntheticBackend, waitFor} from './helpers/v1-app-fixture.mjs';
import {lenderFixture, until} from './helpers/v1-lender-fixture.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {legacyProxyHarness} from './helpers/legacy-proxy-harness.mjs';

const CODEX_RUN = {model: 'gpt-6-sol'};
const HAIKU = 'claude-haiku-5-5';
const MICRO = 1_000_000, HOUR = 3_600_000;
const safetyAdapters = ['claude-code-subscription', 'codex'].map(id => ({spec: legacyProxyHarness(id), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: [id === 'codex' ? 'gpt-6-sol' : HAIKU], capabilities: []}));
const claudeAdapter = () => [{spec: legacyProxyHarness('claude-code-subscription'), installed: true, signedIn: true,
  harnessVersion: 'synthetic-only', models: [HAIKU], capabilities: []}];
const settingsOn = (provider = 'codex') => () => ({intent: 'on', limits: {lendingPolicy: normalizeLendingPolicy({
  providerConsent: {[provider]: true}, accountPlans: {[provider]: 'max20'},
})}});
function fluidAttestation({start, used, resets}) {
  const weekly = 7 * 24 * HOUR, short = 5 * HOUR;
  const limit = (id, durationMs) => ({id, provider: 'claude', unit: 'quota_percent', capacity: 100, durationMs,
    reset: {kind: 'first-use'}, scope: {kind: 'account'},
    weights: {version: 'synthetic-exact/1', nativeUnit: 'usd', byModel: {[HAIKU]: 1, 'claude-sonnet-5-5': 1,
      'claude-opus-5-5': 1}}});
  return {
    quotaRegistry: {version: 'synthetic-attested/1', complete: true,
      limits: [limit('seven_day', weekly), limit('five_hour', short)]},
    registryProvenance: 'Synthetic complete account roster and exact USD weights (test attestation).',
    roundingPoints: 0,
    roundingProvenance: 'Synthetic exact provider rounding (test attestation).',
    nativeCostBounds: requestedUsdMicro => ({unit: 'usd', lower: 0, upper: requestedUsdMicro / MICRO}),
    ledgerSnapshot: {account: 'synthetic-account', windows: [
      {window_id: 'seven_day', window_minutes: 10080, used_pct: used.weekly / MICRO, resets_at: start + resets.weekly,
        observed_at: start, state: 'open', lent_pct: 0, reserved_pct: 0},
      {window_id: 'five_hour', window_minutes: 300, used_pct: used.short / MICRO, resets_at: start + resets.short,
        observed_at: start, state: 'open', lent_pct: 0, reserved_pct: 0}]},
    entries: [], history: [],
    rateHistory: [['seven_day', weekly], ['five_hour', short]].map(([window_id, length_ms]) => ({window_id,
      start_at: start - 2 * HOUR, resets_at: start - 2 * HOUR + length_ms, length_ms, complete: false, censored: false,
      source: 'probe', rounding_points: 0, metadata: {measurement: 'exact'},
      trace: [[start - 2 * HOUR, 0], [start - HOUR, 2]]})),
  };
}
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
};

function launch(f) {
  const controller = new AbortController();
  const lender = createLender({client: f.client, backend: f.backend, adapters: f.adapters, policy: f.policy, clock: f.clock,
    approve: async () => true, onEvent: event => f.events.push(event)});
  const running = lender.start(controller.signal);
  let failure;
  const settled = Promise.resolve(running).catch(error => { failure = error; });
  f.stop = async () => {
    controller.abort();
    await Promise.race([settled, new Promise((_, reject) => setTimeout(() => reject(new Error('lender shutdown timed out')), 3000))]);
    if (failure && failure.name !== 'AbortError' && failure.code !== 'aborted') throw failure;
  };
  return lender;
}

test('the default app wiring applies the measured reserve with plenty of legacy quota remaining', {timeout: 180000}, async t => {
  const f = await appFixture(t);
  const start = Date.now(), used = {weekly: 80 * MICRO, short: 0}, resets = {weekly: 126 * HOUR, short: 1.25 * HOUR};
  const source = createSyntheticPace50Source({start, used, resets, kappa: {weekly: MICRO, short: MICRO}});
  const remaining = 80;
  let quotaReads = 0;
  const {owner, lender, circle} = await f.connect({
    adapters: claudeAdapter,
    quotaReader: async () => { quotaReads++; return {provider: 'claude', remaining, observedAt: Date.now(), resetsAt: Date.now() + 86400000}; },
    lendingPace50: {source, account: 'synthetic-account', account_week_id: 'synthetic-week-1'},
    lendingRuleAttestation: fluidAttestation({start, used, resets}),
  });
  await api(lender.app, '/api/lending/limits', {method: 'POST', body: {quotaReserve: 30,
    dailyJobs: 3, dailyMinutes: 60, maxWallSeconds: 1200, idleOnly: false,
    lendingPolicy: {providerConsent: {claude: true}}}});
  await api(lender.app, '/api/agents/claude-code-subscription', {method: 'POST', body: {useForLending: true}});
  await api(lender.app, '/api/agents/claude-code-subscription/run', {method: 'POST', body: {model: HAIKU, effort: null}});
  await api(lender.app, '/api/lending/on', {method: 'POST', body: {circle: circle.id}});
  await api(lender.app, '/api/lending/mode', {method: 'POST', body: {circle: circle.id, mode: 'auto'}});
  await api(lender.app, '/api/lending/owner-settings', {method: 'POST', body: {maxJobUsd: 20,
    reason: 'Synthetic test: per-job limit for the fluid reserve workload.'}});
  const home = await api(lender.app, '/api/home');
  assert.equal(home.allowance.remaining, remaining, 'the displayed legacy reading is 80% remaining');
  assert.equal(quotaReads > 0, true, 'the app read the legacy allowance');
  await api(owner.app, '/api/jobs', {method: 'POST', body: {circle: circle.id,
    git: {url: 'https://github.com/example/synthetic.git', commit: '1'.repeat(40)},
    prompt: 'Synthetic measured-reserve check.', harness: 'claude-code-subscription', budget_v1: {max_list_usd: 20}}});
  const decision = await waitFor(async () => {
    const view = await api(lender.app, '/api/lending');
    const row = view.objective?.accounts?.find(account => account.provider === 'claude');
    return row?.decision?.lastJobDecision ?? null;
  }, 'the objective candidate measured-reserve decision');
  assert.equal(decision.admitted, false, 'the objective candidate denies the job');
  assert.equal(decision.objective.ruleReasonCode, 'seam_rule_allowance', 'the measured reserve rule denies the job');
  assert.equal(lender.backend.calls.some(([kind]) => kind === 'prepare'), false, 'a refused job creates no sandbox');
  assert.equal(lender.backend.calls.some(([kind]) => kind === 'run'), false, 'a refused job starts no agent');
});

test('a preparation-time quota drop or stale reading is checked again before the agent starts', {timeout: 90000, todo: 'The lender does not revalidate the objective grant after backend preparation.'}, async t => {
  const outcomes = [];
  for (const next of ['deny', 'stale']) {
    const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
    f.policy.userActive = async () => false;
    let state = 'allow';
    const source = createSyntheticPace50Source({start: f.clock.now()});
    const baseObserve = source.observe.bind(source);
    source.observe = async args => {
      if (state === 'stale') return {...await baseObserve(args), refresh_succeeded: false, probe: {reason: 'stale'}};
      return baseObserve(args);
    };
    const baseObjective = source.objectiveInputFor.bind(source);
    source.objectiveInputFor = args => state === 'deny' ? {refuse: 'owner_reserve'} : baseObjective(args);
    const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn(), backend: {}, presence: () => false,
      lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
      pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
    const preparation = deferred(), entered = deferred();
    const prepare = f.backend.prepare.bind(f.backend);
    f.backend.prepare = async (...args) => { entered.resolve(); await preparation.promise; return prepare(...args); };
    f.policy.lendingRuntime = runtime;
    launch(f);
    await entered.promise;
    state = next;
    if (next === 'stale') f.clock.advance(31000);
    preparation.resolve();
    await until(() => f.calls.some(([kind]) => kind === 'run') || f.events.some(event => event.status === 'declined'), 'prepare release outcome');
    outcomes.push(f.calls.some(([kind]) => kind === 'run'));
    await f.stop();
    await runtime.close();
  }
  assert.deepEqual(outcomes, [false, false], 'neither fresh denial nor stale evidence may start an agent');
});

test('the live meter path bounds spend through the candidate grant and copy names the right promise', {timeout: 90000,
  todo: 'The UI says the remaining allowance is kept, while the candidate path no longer enforces the old weekly reserve percentage.'}, async t => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, harness: 'claude-code-subscription',
    mutateJob: payload => { payload.requirements.model = {any_of: [HAIKU]}; }, run: {model: HAIKU}});
  f.adapters[0].models = [HAIKU];
  f.policy.userActive = async () => false;
  const source = createSyntheticPace50Source({start: f.clock.now()});
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn('claude'), backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  const issued = deferred(), held = deferred();
  const start = f.backend.start.bind(f.backend);
  let grant = null;
  f.backend.start = async (handle, opts = {}) => {
    if (handle._entrypoint.includes('claude --print')) {
      grant = opts.lendingBudget?.budget?.limit ?? null;
      issued.resolve();
      opts.onMeter?.({cost_usd: 0, tokens: {input: 0, cached_input: 0, cache_write: 0, output: 0, reasoning_output: 0}, final: false});
      opts.onMeter?.({cost_usd: (grant ?? 0) + 1, tokens: null, final: false});
      await held.promise;
      return;
    }
    return start(handle, opts);
  };
  f.policy.lendingRuntime = runtime;
  launch(f);
  await issued.promise;
  await until(() => f.calls.some(([kind]) => kind === 'cancel') || f.events.some(event => event.status === 'stopping'), 'meter stop path');
  assert.ok(Number.isFinite(grant) && grant > 0, 'the backend receives the candidate grant');
  assert.ok(f.events.some(event => event.status === 'stopping' && event.reason === 'provider_limit'), 'over-grant meter usage requests a provider-limit stop');
  held.resolve();
  await f.stop();
  await runtime.close();
  const promiseCopy = await Promise.all([
    readFile(new URL('../ui/v1/src/helpers.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../ui/v1/src/view-models.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../ui/v1/src/safety-copy.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../lib/v1/lending-log.mjs', import.meta.url), 'utf8'),
    readFile(new URL('../lib/v1/lending-status-copy.mjs', import.meta.url), 'utf8'),
  ]).then(files => files.join('\n'));
  assert.deepEqual([
    promiseCopy.includes('Your remaining allowance is being kept for you.'),
    promiseCopy.includes('of my weekly Claude allowance for me.'),
    promiseCopy.includes('keeps 30% for your use.'),
  ], [false, false, false], 'the installed candidate path must not make an old hard weekly balance promise');
});

test('display and admission reject a cached reading after its window resets', {timeout: 90000}, async t => {
  const f = await lenderFixture(t, {policy: {mode: 'auto'}, run: CODEX_RUN});
  f.policy.userActive = async () => false;
  const reset = f.clock.now() + 1000;
  const source = createSyntheticPace50Source({start: f.clock.now(), resets: {weekly: 1000, short: 1000}});
  let reads = 0;
  const observe = source.observe.bind(source);
  source.observe = async args => { reads++; return observe(args); };
  const runtime = createLendingRuntime({directory: join(f.root, 'pace50'), settings: settingsOn(), backend: {}, presence: () => false,
    lastActiveAt: () => null, selfKey: () => null, now: () => f.clock.now(),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1', source}});
  f.policy.lendingRuntime = runtime;
  const before = await runtime.candidate.projectStatus({provider: 'codex'});
  assert.ok(before, 'the pre-reset reading populates the displayed candidate status');
  f.clock.advance(2000);
  const display = await runtime.candidate.projectStatus({provider: 'codex', snapshotOnly: true});
  launch(f);
  await until(() => f.events.some(event => event.status === 'declined') || f.calls.some(([kind]) => kind === 'run'), 'post-reset admission');
  const admitted = f.calls.some(([kind]) => kind === 'run');
  await f.stop();
  assert.ok(reads >= 2, `reset crossing refreshes the cached observation; reads=${reads}`);
  assert.equal(display.admitted, false, 'display treats an expired window as unknown/held');
  assert.equal(admitted, false, `a window reset at ${reset} cannot authorize an admission from its old reading`);
  await runtime.close();
});

test('a transient automatic safety-test wait retries after readiness recovers at the same versions', {timeout: 120000, todo: 'A same-version automatic retry is suppressed after a wait without a new verdict.'}, async t => {
  const f = await appFixture(t), backend = syntheticBackend(f.root, {sandboxSafety: true});
  let runs = 0;
  const pass = {state: 'passed', agents: ['codex'], parts: [{id: 'codex:sandbox', status: 'passed'}]};
  const options = {backend, adapters: safetyAdapters, sandboxTest: undefined, faravanVersion: '0.12.0', blockerRecheckMs: 20,
    sandboxTestRunner: async () => ++runs === 2 ? {state: 'waits', waits_for: 'docker_running', agents: [], parts: []} : pass};
  const first = await f.connect(options);
  await api(first.lender.app, '/api/agents/codex', {method: 'POST', body: {useForLending: true}});
  await api(first.lender.app, '/api/lending/on', {method: 'POST', body: {circle: first.circle.id}});
  await api(first.lender.app, '/api/readiness?refresh=true');
  const oldStart = await api(first.lender.app, '/api/setup/test', {method: 'POST', body: {}, status: 202});
  const oldView = await waitFor(async () => {
    const view = await api(first.lender.app, '/api/setup/test');
    return view.state !== 'running' ? view : null;
  }, 'old-version safety verdict', 10000);
  assert.equal(oldView.state, 'passed', JSON.stringify({oldView, runs}));
  assert.ok(oldStart.id, 'the manual safety run has an identity');
  await first.lender.app.close();
  const next = await f.start('lender', {...options, faravanVersion: '0.13.0'});
  await waitFor(() => runs === 2, 'automatic new-version retest');
  await waitFor(async () => (await api(next.app, '/api/setup/test')).state === 'waits', 'transient automatic wait');
  const storedAfterWait = JSON.parse(await readFile(join(next.home, 'v1', 'sandbox-test.json'), 'utf8'));
  assert.equal(storedAfterWait.id, oldView.id, 'a wait does not replace the previous version-bound verdict');
  await api(next.app, '/api/readiness?refresh=true');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(runs, 3, 'recovered readiness should launch a new same-version automatic test');
  assert.equal((await api(next.app, '/api/setup/test')).state, 'passed', 'the retry stores a passing verdict');
});

test('DELETE during safety-test prepare or start aborts the backend and removes a late sandbox', {timeout: 120000, todo: 'Safety-test cancellation does not pass an abort signal to backend prepare or start.'}, async t => {
  const observations = [];
  for (const phase of ['prepare', 'start']) {
    const f = await appFixture(t), backend = syntheticBackend(f.root, {sandboxSafety: true});
    const entered = deferred(), release = deferred();
    const originalPrepare = backend.prepare.bind(backend), originalStart = backend.start.bind(backend);
    let seenSignal = false, enteredOperation = false;
    if (phase === 'prepare') backend.prepare = async (...args) => {
      seenSignal ||= Boolean(args[1]?.signal);
      enteredOperation = true; entered.resolve(); await release.promise;
      return originalPrepare(...args);
    };
    else backend.start = async (...args) => {
      const [handle, opts] = args;
      if (handle._entrypoint.startsWith('node -e ')) {
        seenSignal ||= Boolean(opts?.signal);
        enteredOperation = true; entered.resolve(); await release.promise;
      }
      return originalStart(...args);
    };
    const {app} = await f.start('owner', {backend, adapters: safetyAdapters, sandboxTest: undefined});
    await api(app, '/api/readiness?refresh=true');
    const started = await api(app, '/api/setup/test', {method: 'POST', body: {}, status: 202});
    assert.equal(started.state, 'running', 'the real safety tester accepts the run');
    await waitFor(() => enteredOperation, `backend ${phase} started`);
    let deleteSettled = false;
    const deleting = api(app, '/api/setup/test', {method: 'DELETE'}).then(value => {deleteSettled = true; return value;});
    await new Promise(resolve => setTimeout(resolve, 50));
    const interrupted = deleteSettled;
    release.resolve();
    await deleting;
    observations.push({phase, seenSignal, interrupted, destroyed: backend.calls.some(([kind]) => kind === 'destroy')});
  }
  assert.deepEqual(observations, [
    {phase: 'prepare', seenSignal: true, interrupted: true, destroyed: true},
    {phase: 'start', seenSignal: true, interrupted: true, destroyed: true},
  ], 'both phases receive cancellation promptly and remove any late sandbox');
});
