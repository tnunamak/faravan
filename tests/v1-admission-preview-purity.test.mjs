import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {createMeasurementHistory} from '../lib/v1/event-history.mjs';
import {normalizeLendingPolicy} from '../lib/v1/lending-policy.mjs';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {compareExpectedLoss, compareExpectedLosses} from '../lib/v1/lending-continuous-model.mjs';
import {ACCOUNT, NOW, WEEK, MICRO, ordinaryInput} from './helpers/pace50-fixtures.mjs';

const model = 'claude-haiku-4-5';
const args = {provider: 'claude', model, plan: 'max20'};
const offer = (id = 'purity-offer') => ({id, resource: 'claude', model,
  budget_v1: {max_list_usd: 10, effort: 'low'}, expires_at: new Date(NOW + 3_600_000).toISOString(),
  requirements: {limits: {wall_seconds: 300}}, prompt: 'PRIVATE-PURITY-FIXTURE'});
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return {promise, resolve}; };

function bytes(directory) {
  const entries = [];
  function visit(path, relative) {
    for (const name of fs.readdirSync(path).sort()) {
      const child = join(path, name), key = relative ? `${relative}/${name}` : name;
      const stat = fs.lstatSync(child);
      if (stat.isSymbolicLink()) entries.push([key, 'symlink', fs.readlinkSync(child)]);
      else if (stat.isDirectory()) { entries.push([key, 'directory']); visit(child, key); }
      else entries.push([key, fs.readFileSync(child).toString('base64')]);
    }
  }
  visit(directory, '');
  return entries;
}

async function setup(t, {readOnlyPreview = true, ownerSettingsState = 'set', historyFails = false, realCallbacks = false,
  buildInput = null} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'preview-purity-'));
  const calls = {live: 0, presence: 0, readOverride: 0, origins: 0, io: [], effects: [], backend: 0, consume: 0};
  let clock = NOW, hook = null;
  const input = ordinaryInput({now: NOW});
  const observation = {refresh_succeeded: true, complete: true, identity: {verified: true, account_id: ACCOUNT},
    account_week_id: WEEK, epoch: 'epoch-1', weekly_resource_id: 'weekly', resources: input.windows,
    funding: {subscription_only: 'proven'}, executor: {single_executor: 'proven'},
    stop: {bounded_execution: 'proven'}, stop_bound_ms: 60_000, uncertainty_ms: 30_000};
  const objective = input.objective;
  const historyRows = new Map(input.windows.map(window => [window.id, new Map([
    [window.anchor_at - 1, {score: 10, complete: true, nested: {sentinel: window.id}}],
  ])]));
  let history = {weeklyScores(id) { if (historyFails) throw new Error('history unavailable'); return historyRows.get(id); }};
  const saved = {enabled: true, intent: 'on', activeCircle: 'fixture', modes: {fixture: 'auto'},
    limits: {lendingPolicy: normalizeLendingPolicy({accountPlans: {claude: 'max20'}, providerConsent: {claude: true}})}};
  const ownerSettings = createOwnerSettings({directory, now: () => clock});
  if (ownerSettingsState === 'set') ownerSettings.set({by: 'fixture', reason: 'synthetic cap', now: NOW, maxJobUsd: 20});
  if (ownerSettingsState === 'unreadable') fs.writeFileSync(join(directory, 'owner-settings.json'), '{broken');
  const origins = new Map();
  let presenceOverrides = {available: () => ({granted: false}), consume() { calls.consume++; }};
  let windowOrigins = {
    observeOpen({windows}) { calls.origins++; for (const window of windows) origins.set(window.window_id, 'owner'); },
    originFor() { return 'owner'; },
  };
  if (realCallbacks) {
    const {createLendingHistory, createPresenceOverrideStore, createWindowOriginStore} = await callbackModules();
    const {createLendingLedger} = await import('../lib/v1/lending-ledger.mjs');
    const ledger = createLendingLedger({file: join(directory, 'meter-ledger.json'), now: () => clock});
    history = createLendingHistory({home: directory, account: 'claude', ledger, now: () => clock});
    history.bootstrapFromSessionLogs({readWeeklyUsage: () => input.windows.map(window => ({resource: window.id,
      epoch: NOW - 1000, owner_usage_pct: 10, complete: true,
      censoring: {complete: true, limit_reached: false, owner_refused: false, owner_deferred: false}}))});
    presenceOverrides = createPresenceOverrideStore({directory: join(directory, 'presence')});
    presenceOverrides.request({jobId: 'purity-offer', by: 'fixture', reason: 'preview override', now: NOW, ttlMs: 60_000});
    windowOrigins = createWindowOriginStore({directory: join(directory, 'origins')});
  }
  const io = {
    openSync(...v) { calls.io.push(['open', ...v]); return fs.openSync(...v); },
    writeAllSync(...v) { calls.io.push(['write']); return fs.writeFileSync(...v); },
    fsyncSync(...v) { calls.io.push(['fsync']); return fs.fsyncSync(...v); },
    closeSync(...v) { calls.io.push(['close']); return fs.closeSync(...v); },
    renameSync(...v) { calls.io.push(['rename']); return fs.renameSync(...v); },
    unlinkSync(...v) { calls.io.push(['unlink']); return fs.unlinkSync(...v); },
    fsyncDirectory(path) {
      calls.io.push(['directory-fsync']);
      const fd = fs.openSync(path, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    },
  };
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window',
    'cancel_pending_attempt', 'request_cessation', 'request_fresh_complete_reconciliation'].map(name =>
    [name, async effect => { calls.effects.push([name, structuredClone(effect)]); return () => {}; }]));
  // The runtime's own capture partition, held so the fixture can flush it. Same arguments as the runtime's
  // default, so the writer is the production writer; the fixture gains a handle to it.
  const capture = createMeasurementHistory({directory: join(directory, 'history')});
  const runtime = createLendingRuntime({directory, now: () => clock, settings: () => saved,
    presence: () => { calls.presence++; return false; },
    readOverride: () => { calls.readOverride++; throw new Error('live read forbidden'); },
    backend: new Proxy({}, {get() { calls.backend++; throw new Error('backend forbidden'); }}),
    pace50: {account: ACCOUNT, account_week_id: WEEK, readOnlyPreview, io, effects, ownerSettings, history, measurementHistory: capture,
      presenceOverrides,
      ...(buildInput ? {buildInput} : {}),
      source: {stopBoundMs: 60_000, uncertaintyMs: 30_000,
        observe: async () => { calls.live++; return observation; }},
      objectiveInputFor: async evidence => { await hook?.(evidence); return objective; },
      windowOrigins}});
  t.after(async () => { await runtime.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  await runtime.pace50.transition({type: 'on', event_id: 'on', at: NOW}, {expectedRevision: 0});
  await runtime.pace50.transition({type: 'owner_absent', event_id: 'absent', at: NOW},
    {expectedRevision: runtime.pace50.state().revision});
  fs.writeFileSync(join(directory, 'sentinel.bin'), Buffer.from([0, 255, 1, 10]));
  // The constructor's capture_epoch_started is queued, not yet on disk; it must land before any baseline is taken.
  await capture.flush();
  const warm = () => runtime.candidate.observe({...args, now: clock});
  const snapshot = () => ({bytes: bytes(directory), state: runtime.pace50.state(),
    calls: structuredClone(calls), observation: structuredClone(observation), historyRows: structuredClone(historyRows),
    origins: structuredClone(origins), objective: structuredClone(objective), saved: structuredClone(saved),
    decision: structuredClone(runtime.candidate.lastJobDecisionFor('claude')), busy: runtime.busy()});
  // Waits for queued capture writes, then takes the byte snapshot. Comparisons after a preview use this, so a
  // preview that writes measurement rows fails here deterministically instead of racing the writer.
  const settled = async () => { await capture.flush(); return snapshot(); };
  return {runtime, directory, calls, input, objective, observation, historyRows, origins, saved,
    warm, snapshot, settled, setHook: value => { hook = value; }, setNow: value => { clock = value; }};
}

test('P1: repeated and parallel production-path previews preserve durable bytes, cache identities, inputs, and all effect counters', async t => {
  const f = await setup(t);
  await f.warm();
  const cache = f.runtime.candidate.observeSnapshot(args);
  const before = await f.settled();
  const job = offer(), original = structuredClone(job);
  for (let index = 0; index < 40; index++) assert.equal((await f.runtime.previewAdmission(job, {ownerAbsent: true})).admitted, true);
  const outcomes = await Promise.all(Array.from({length: 40}, () => f.runtime.previewAdmission(job, {ownerAbsent: true})));
  assert.ok(outcomes.every(out => out.admitted));
  assert.deepEqual(await f.settled(), before);
  assert.strictEqual(f.runtime.candidate.observeSnapshot(args), cache);
  assert.deepEqual(job, original);
  assert.ok(!JSON.stringify(outcomes).includes('PRIVATE-PURITY-FIXTURE'));
  assert.strictEqual(await f.warm(), cache, 'admission still reuses the same cache entry');
  // warm() queued two cache-hit observation rows; settle them into the baseline so the comparison covers only the preview.
  const afterWarm = await f.settled();
  const check = await f.runtime.previewAdmission(offer(), {ownerAbsent: true});
  assert.equal(check.admitted, true);
  assert.deepEqual(await f.settled(), afterWarm, 'preview must preserve the full snapshot after cache-hit observation settles');
  assert.strictEqual(f.runtime.candidate.observeSnapshot(args), cache);
});

test('P2: snapshot builder receives isolated mutable observation, request, context, state and history score Maps', async t => {
  const f = await setup(t);
  await f.warm();
  const before = await f.settled();
  f.setHook(({state, request, context, observation, input, weeklyScores, snapshotOnly}) => {
    assert.equal(snapshotOnly, true);
    state.attempts.push({id: 'builder-local'});
    request.job_id = 'builder-local';
    context.strategyParams.builderLocal = true;
    observation.resources[0].used_micro = 0;
    input.windows[0].used_micro = 0;
    const rows = weeklyScores.get('weekly');
    rows.values().next().value.nested.sentinel = 'builder-local';
    rows.set(-1, {score: 99, complete: true});
  });
  await f.runtime.previewAdmission(offer(), {ownerAbsent: true});
  assert.deepEqual(await f.settled(), before, 'callback-local changes must not touch admission-shared score rows');
});

test('P3: cached status snapshot propagates snapshotOnly and never records origins or mutates cached objective', async t => {
  const f = await setup(t);
  await f.warm();
  const before = await f.settled();
  const flags = [];
  f.setHook(({snapshotOnly}) => flags.push(snapshotOnly));
  const out = await f.runtime.candidate.projectStatus({...args, ownerAbsent: true, snapshotOnly: true});
  assert.equal(typeof out.admitted, 'boolean');
  assert.deepEqual(await f.settled(), before);
  assert.deepEqual(flags, [true]);
});

test('jobless status ages a retained reading past the offer snapshot deadline', async t => {
  const f = await setup(t);
  await f.warm();
  const status = () => f.runtime.candidate.projectStatus({...args, automatic: true, snapshotOnly: true});
  f.setNow(NOW + 29_999);
  const beforeDeadline = await status();
  f.setNow(NOW + 30_000);
  const atDeadline = await status();
  assert.equal(atDeadline.reason, beforeDeadline.reason);
  assert.notEqual(atDeadline.reason, 'objective_evidence_unknown');
  const before = await f.settled();
  f.setNow(NOW + 30_001);
  const assessedAt = [];
  f.setHook(({now}) => assessedAt.push(now));
  assert.equal((await status()).reason, atDeadline.reason);
  assert.deepEqual(assessedAt, [NOW + 30_001]);
  assert.equal((await f.runtime.previewAdmission(offer(), {ownerAbsent: true})).reasonCode, 'objective_evidence_unknown');
  assert.deepEqual(await f.settled(), before);
  await f.runtime.candidate.release('not-started', {prepared: true});
  assert.equal((await status()).reason, 'objective_evidence_unknown');
});

test('P4: pending previews never hold the writer queue and an interleaved admission is the only writer', {timeout: 10_000}, async t => {
  const f = await setup(t);
  await f.warm();
  const started = deferred(), release = deferred();
  let waiting = 0;
  f.setHook(async ({snapshotOnly}) => {
    if (snapshotOnly) { if (++waiting === 24) started.resolve(); await release.promise; }
  });
  const previews = Array.from({length: 24}, (_, i) => f.runtime.previewAdmission(offer(`preview-${i}`), {ownerAbsent: true}));
  await started.promise;
  const before = f.runtime.pace50.state();
  const job = offer('real-admission');
  const admitted = await f.runtime.reserve({provider: 'claude', model, job, jobId: job.id,
    attemptId: 'real-admission', automatic: true, ownerAbsent: true, intentOn: true});
  assert.equal(admitted.ok, true);
  assert.equal(f.runtime.pace50.state().revision, before.revision + 1);
  assert.equal(f.runtime.pace50.state().attempts.length, 1);
  const afterAdmission = await f.settled();
  release.resolve();
  const outcomes = await Promise.all(previews);
  assert.ok(outcomes.every(out => !out.admitted && out.reasonCode === 'objective_evidence_unknown'),
    'admission invalidated the snapshots while their builders yielded');
  assert.deepEqual(await f.settled(), afterAdmission);
  assert.equal(f.runtime.candidate.lastJobDecisionFor('claude').admitted, true);
  assert.equal(f.runtime.busy(), true);
});

test('P5: cold, mismatched, expired and backwards-clock snapshots fail closed without refreshing or changing generation', async t => {
  const f = await setup(t);
  const cold = await f.settled();
  assert.equal((await f.runtime.previewAdmission(offer(), {ownerAbsent: true})).reasonCode, 'objective_evidence_unknown');
  assert.deepEqual(await f.settled(), cold);
  await f.warm();
  const cache = f.runtime.candidate.observeSnapshot(args), before = await f.settled();
  assert.equal((await f.runtime.previewAdmission({...offer(), model: 'claude-sonnet-4-5'}, {ownerAbsent: true})).admitted, false);
  f.setNow(NOW + 30_001);
  assert.equal((await f.runtime.previewAdmission(offer(), {ownerAbsent: true})).reasonCode, 'objective_evidence_unknown');
  f.setNow(NOW - 1);
  assert.equal((await f.runtime.previewAdmission(offer(), {ownerAbsent: true})).reasonCode, 'objective_evidence_unknown');
  f.setNow(NOW);
  assert.strictEqual(f.runtime.candidate.observeSnapshot(args), cache, 'an expired read did not evict or replace the cache');
  assert.deepEqual(await f.settled(), before);
});

test('P6: snapshot replaced during an asynchronous build is rejected without preview-origin writes', async t => {
  const f = await setup(t);
  await f.warm();
  const started = deferred(), release = deferred();
  f.setHook(async () => { started.resolve(); await release.promise; });
  const pending = f.runtime.previewAdmission(offer(), {ownerAbsent: true});
  await started.promise;
  await f.runtime.candidate.refreshObservation({...args, now: NOW});
  const afterRefresh = await f.settled();
  release.resolve();
  assert.equal((await pending).reasonCode, 'objective_evidence_unknown');
  assert.deepEqual(await f.settled(), afterRefresh);
});

test('P7: projected account-week rollover does not persist or dispatch its proposed effects', async t => {
  const f = await setup(t);
  f.observation.account_week_id = `${f.observation.identity.account_id}:weekly:${f.observation.resources.find(r => r.kind === 'weekly').resets_at}`;
  await f.warm();
  const before = await f.settled();
  const out = await f.runtime.previewAdmission(offer(), {ownerAbsent: true});
  assert.equal(out.admitted, true);
  assert.equal(f.runtime.pace50.state().account_week_id, WEEK);
  assert.deepEqual(await f.settled(), before);
});

test('P8: rejected settings, unreadable fixture readings and failed history are read-only', async t => {
  const corrupt = await setup(t, {ownerSettingsState: 'unreadable'});
  const beforeCorrupt = await corrupt.settled();
  assert.equal((await corrupt.runtime.previewAdmission(offer(), {ownerAbsent: true})).reasonCode, 'owner_settings_unreadable');
  assert.deepEqual(await corrupt.settled(), beforeCorrupt);
  const f = await setup(t, {historyFails: true});
  await f.warm();
  const before = await f.settled();
  const fixture = {windows: [{window_id: 'weekly', used_pct: null, readable: false}]};
  assert.equal((await f.runtime.previewAdmission(offer(), {ownerAbsent: true, readings: fixture})).reasonCode, 'objective_usage_unknown');
  assert.deepEqual(await f.settled(), before);
});

test('P9: capability stays off by default and an offer cannot assert it', async t => {
  const f = await setup(t, {readOnlyPreview: false});
  await f.warm();
  f.setHook(() => { throw new Error('unapproved callback'); });
  const before = await f.settled();
  const out = await f.runtime.previewAdmission(offer(), {ownerAbsent: true, readOnlyPreview: true});
  assert.equal(out.reasonCode, 'objective_evidence_unknown');
  assert.deepEqual(await f.settled(), before);
});

test('P10: explicit capability is a callback trust contract, not a sandbox for closure side effects', async t => {
  const f = await setup(t);
  await f.warm();
  let externalCache = 0;
  f.setHook(() => { externalCache++; });
  const before = await f.settled();
  assert.equal((await f.runtime.previewAdmission(offer(), {ownerAbsent: true})).admitted, true);
  assert.equal(externalCache, 1, 'startup must audit supplied callbacks; core clones cannot protect callback closure state');
  assert.deepEqual(await f.settled(), before, 'preview wrote capture rows');
});

test('P11: continuous-model tie comparisons do not reuse mutable rounding scratch across previews and admission', async t => {
  const f = await setup(t);
  f.objective.band.weeks = [];
  f.objective.job.chunkCandidates = [{id: 'small', usdMicro: 2 * MICRO, friendValue: 100},
    {id: 'large', usdMicro: 10 * MICRO, friendValue: 100}];
  for (const window of f.observation.resources) window.used_micro = MICRO;
  await f.warm();
  const before = await f.settled();
  let seen = new Set();
  const original = DataView.prototype.setFloat64;
  t.mock.method(DataView.prototype, 'setFloat64', function (...values) {
    seen.add(this);
    return original.apply(this, values);
  });
  const first = await f.runtime.previewAdmission(offer(), {ownerAbsent: true});
  assert.equal(first.admitted, true);
  assert.ok(seen.size > 0, 'exercise outward-rounded comparison, not just the model early-hold branch');
  const priorViews = seen;
  seen = new Set();
  assert.equal((await f.runtime.previewAdmission(offer(), {ownerAbsent: true})).admitted, true);
  assert.ok([...seen].every(view => !priorViews.has(view)), 'preview must not write admission-shared numerical scratch');
  assert.deepEqual(await f.settled(), before);
  const previewViews = new Set([...priorViews, ...seen]);
  seen = new Set();
  const job = offer('real-model');
  assert.equal((await f.runtime.reserve({provider: 'claude', model, job, jobId: job.id,
    attemptId: 'real-model', automatic: true, ownerAbsent: true, intentOn: true})).ok, true);
  assert.ok([...seen].every(view => !previewViews.has(view)));
});

test('P12: serializable history/scenario, manual, typed-strategy and schedule branches preserve all shared inputs', async t => {
  const f = await setup(t);
  await f.warm();
  f.objective.owner.scenarios = [{probability: 1, attempts: [
    {need: {weekly: 40, short: 20}, value: 10, atomic: false},
    {need: {weekly: 10, short: 10}, value: 10, atomic: true}]}];
  const ratio = (n, d = 1n) => ({n: BigInt(n), d});
  f.objective.resetIndexedSchedule = {
    resources: [{id: 'weekly@now', capacityMicro: 80 * MICRO}, {id: 'short@now', capacityMicro: 60 * MICRO}],
    weights: [ratio(1)], candidates: [{id: 'immediate', scheduleProven: true, firstActionId: 'job',
      firstActionCostsMicro: {weekly: 500_000, short: 2 * MICRO},
      costsMicro: {'weekly@now': 500_000, 'short@now': 2 * MICRO},
      usefulValues: [ratio(100)], ownerLosses: [ratio(0)],
      envelope: {stoppable: true, finishesBeforeReset: true, unknownUsageHeld: true, ownerCapFits: true}}],
  };
  for (const [strategy, strategyParams, automatic] of [
    ['automatic', {}, true], ['fixed_share', {fixedSharePct: 20, keepPct: 20}, true],
    ['custom', {e0: 0.25}, true], ['automatic', {}, false],
  ]) {
    f.objective.strategy = strategy;
    f.objective.strategyParams = strategyParams;
    f.objective.automatic = automatic;
    const before = await f.settled();
    const out = await f.runtime.previewAdmission(offer(), {ownerAbsent: true, automatic});
    assert.equal(out.admitted, true);
    assert.deepEqual(await f.settled(), before);
  }
});

test('P13: local rounding scratch preserves IEEE-754 boundary behavior and deterministic loss comparisons', async () => {
  // Exercise the exact private helpers without adding a production debug/export API.
  const source = fs.readFileSync(new URL('../lib/v1/lending-continuous-model.mjs', import.meta.url), 'utf8');
  const isolated = source.slice(source.indexOf('function nextUp('), source.indexOf('function monotonePanel('));
  const rounding = await import('data:text/javascript,' + encodeURIComponent(
    'const roundingView = new DataView(new ArrayBuffer(8));\n' + isolated + '\nexport {nextUp, nextDown};'));
  const reference = (value, up) => {
    if (Number.isNaN(value) || value === (up ? Infinity : -Infinity)) return value;
    if (value === 0) return up ? Number.MIN_VALUE : -Number.MIN_VALUE;
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, value);
    const bits = view.getBigUint64(0);
    view.setBigUint64(0, up ? (value > 0 ? bits + 1n : bits - 1n) : (value > 0 ? bits - 1n : bits + 1n));
    return view.getFloat64(0);
  };
  const values = [NaN, Infinity, -Infinity, 0, -0, Number.MIN_VALUE, -Number.MIN_VALUE,
    Number.MAX_VALUE, -Number.MAX_VALUE, Number.EPSILON, -Number.EPSILON, 1, -1,
    2 ** -1022, -(2 ** -1022), Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER];
  for (let exponent = -1074; exponent <= 1023; exponent++) {
    values.push(2 ** exponent, -(2 ** exponent));
  }
  for (const value of values) {
    assert.ok(Object.is(rounding.nextUp(value), reference(value, true)));
    assert.ok(Object.is(rounding.nextDown(value), reference(value, false)));
  }
  assert.equal(compareExpectedLoss(() => 0, 1, 0.1).relation, 'below');
  assert.equal(compareExpectedLoss(() => 1, 1, 0.9).relation, 'above');
  assert.equal(compareExpectedLosses(x => x / 2, 0.5, 1), -1);
  assert.equal(compareExpectedLosses(x => x / 2, 1, 0.5), 1);
  assert.equal(compareExpectedLosses(x => x / 2, 1, 1), 0);
});

test('P14: previews of a nonempty admitted ledger never release, reserve, or reissue risk budgets', async t => {
  const f = await setup(t);
  await f.warm();
  const job = offer('held-attempt');
  assert.equal((await f.runtime.reserve({provider: 'claude', model, job, jobId: job.id,
    attemptId: 'held-attempt', automatic: true, ownerAbsent: true, intentOn: true})).ok, true);
  await f.warm();
  const before = await f.settled(), lastDecision = f.runtime.candidate.lastJobDecisionFor('claude');
  const out = await Promise.all(Array.from({length: 30}, (_, i) =>
    f.runtime.previewAdmission(offer(`hypothetical-${i}`), {ownerAbsent: true})));
  assert.ok(out.every(item => item.admitted));
  assert.deepEqual(await f.settled(), before);
  assert.strictEqual(f.runtime.candidate.lastJobDecisionFor('claude'), lastDecision);
  assert.equal(f.runtime.pace50.state().attempts.length, 1);
  assert.ok(f.runtime.pace50.state().attempts[0].resources.every(resource => resource.held_micro > 0));
});

test('P15: previews preserve corrected observation identity and bytes with durable measured-rate memory', async t => {
  const f = await setup(t);
  const resources = f.observation.resources.map(w => ({id: w.id, instance: w.instance, epoch: f.observation.epoch,
    anchor_at: w.anchor_at, resets_at: w.resets_at, used_micro: w.used_micro, kappa_micro: w.kappa_micro * 3}));
  const feedback = await f.runtime.pace50.deliver({type: 'meter_feedback', event_id: 'measured-rate',
    account: ACCOUNT, at: NOW, observed_at: NOW, resources});
  assert.equal(feedback.applied, true);
  await f.runtime.candidate.refreshObservation({...args, now: NOW});
  const cache = f.runtime.candidate.observeSnapshot(args), before = await f.settled();
  assert.equal(cache.resources[0].kappa_micro, resources[0].kappa_micro);
  await Promise.all(Array.from({length: 40}, () => f.runtime.previewAdmission(offer(), {ownerAbsent: true})));
  assert.deepEqual(await f.settled(), before, 'preview wrote capture rows');
  assert.strictEqual(f.runtime.candidate.observeSnapshot(args), cache);
  assert.strictEqual(await f.warm(), cache);
  // warm() queued two cache-hit observation rows; settle them into the baseline so the comparison covers only the preview.
  const afterWarm = await f.settled();
  // Verdict not asserted: this fixture's preview is refused (meter_coverage_required); the check is about writes.
  await f.runtime.previewAdmission(offer(), {ownerAbsent: true});
  assert.deepEqual(await f.settled(), afterWarm, 'preview wrote capture rows after the cache-hit observation settled');
  assert.strictEqual(f.runtime.candidate.observeSnapshot(args), cache);
});

// CALLBACK-AUDIT-START: standalone subset imports only allow-listed real modules.
async function callbackModules() {
  const [{createLendingHistory}, {createPresenceOverrideStore}, {createWindowOriginStore}, {createOwnerPresence}] = await Promise.all([
    import('../lib/v1/lending-history.mjs'), import('../lib/v1/presence-override.mjs'),
    import('../lib/v1/window-origin.mjs'), import('../lib/v1/lending-presence.mjs')]);
  return {createLendingHistory, createPresenceOverrideStore, createWindowOriginStore, createOwnerPresence};
}
function callbackDirectory(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'callback-purity-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  return directory;
}
test('C1: real owner setting reads are detached and preserve absent, set, legacy-after-construction and corrupt bytes', async t => {
  const directory = callbackDirectory(t), store = createOwnerSettings({directory, now: () => NOW});
  let before = bytes(directory);
  for (let i = 0; i < 40; i++) { assert.equal(store.limit().state, 'unset'); store.values(); store.audit(); }
  assert.deepEqual(bytes(directory), before);
  store.set({by: 'fixture', reason: 'cap', now: NOW, maxJobUsd: 20});
  before = bytes(directory);
  for (let i = 0; i < 40; i++) {
    store.values().maxJobUsd = 1; store.audit()[0].changed.maxJobUsd.to = 1;
    assert.equal(store.limit().maxJobUsd, 20);
  }
  assert.deepEqual(bytes(directory), before);
  fs.writeFileSync(join(directory, 'owner-settings.json'), JSON.stringify({version: 1,
    values: {maxJobUsd: 20, weeklyOverrunPoints: 0.1}, audit: []}));
  before = bytes(directory);
  assert.equal(store.limit().state, 'unreadable', 'reads do not trigger constructor-only migration');
  assert.deepEqual(bytes(directory), before);
  fs.writeFileSync(join(directory, 'owner-settings.json'), '{broken');
  before = bytes(directory);
  assert.equal(store.limit().state, 'unreadable'); assert.equal(store.values(), null);
  assert.deepEqual(bytes(directory), before);
});
test('C2: real presence override reads neither consume nor prune, and presence snapshots never sample or report', async t => {
  const {createPresenceOverrideStore, createOwnerPresence} = await callbackModules();
  const directory = callbackDirectory(t), store = createPresenceOverrideStore({directory});
  store.request({jobId: 'one', by: 'fixture', reason: 'explicit', now: NOW, ttlMs: 1000});
  let clock = NOW;
  const presence = createOwnerPresence({now: () => clock});
  presence.report({idleSeconds: 500});
  const before = bytes(directory), old = presence.snapshot();
  for (let i = 0; i < 80; i++) {
    assert.equal(store.available({jobId: 'one', now: NOW}).granted, true);
    assert.equal(store.available({jobId: 'other', now: NOW}).granted, false);
    assert.equal(store.available({jobId: 'one', now: NOW + 1000}).reason, 'expired');
    store.audit()[0].by = 'detached';
    assert.deepEqual(presence.snapshot(), old);
  }
  assert.deepEqual(bytes(directory), before);
  assert.equal(store.consume({jobId: 'one', now: NOW}).granted, true, 'only explicit admission consumes');
  const consumed = bytes(directory);
  assert.equal(store.available({jobId: 'one', now: NOW}).reason, 'already_consumed');
  assert.deepEqual(bytes(directory), consumed);
  clock += 60_001; assert.equal(presence.active(), null);
  assert.equal(presence.snapshot().observed_at, NOW);
});
test('C3: real window origin reads do not record, prune or alias persistent records', async t => {
  const {createWindowOriginStore} = await callbackModules();
  const directory = callbackDirectory(t), store = createWindowOriginStore({directory});
  const window = {window_id: 'short', window_minutes: 300, resets_at: NOW + 3_600_000, state: 'open'};
  const instance = `short@${NOW + 3_600_000}`;
  store.observeOpen({windows: [window], now: NOW});
  store.attestOwnerOpening({windows: [window], instance, by: 'fixture', reason: 'owner', now: NOW});
  const before = bytes(directory);
  for (let i = 0; i < 80; i++) {
    assert.equal(store.originFor(instance), 'owner');
    store.snapshot({now: NOW}).records[0].origin = 'lending';
    assert.equal(store.snapshot({now: NOW + 4_000_000}).seen.length, 0);
  }
  assert.deepEqual(bytes(directory), before);
});
function importRow() {
  return {resource: 'weekly', account_week_id: NOW - 1000, week_start: NOW - 604_801_000,
    score: 20, censored: false, source: 'import', coverage_ratio: 1,
    calibration_window: {sentinel: 'untouched'}, usage_samples: []};
}
test('C4: real history read callbacks return isolated rows, never import, acquire locks or query the ledger', async t => {
  const {createLendingHistory} = await callbackModules();
  const directory = callbackDirectory(t);
  let entries = 0, imports = 0;
  const history = createLendingHistory({home: directory, account: 'claude', now: () => NOW,
    ledger: {entries() { entries++; return []; }}});
  history.bootstrapFromSessionLogs({readWeeklyUsage() { imports++; return [importRow()]; }});
  const before = bytes(directory), baseline = history.weeklyScores('weekly');
  const calls = {entries, imports};
  const mutationMethods = ['writeFileSync', 'mkdirSync', 'symlinkSync', 'unlinkSync', 'renameSync', 'fsyncSync'];
  for (const name of mutationMethods) t.mock.method(fs, name, () => { throw new Error(`read wrote through ${name}`); });
  for (let i = 0; i < 80; i++) {
    const scores = history.weeklyScores('weekly');
    assert.deepEqual(scores, baseline);
    scores.values().next().value.calibration_window.sentinel = 'detached';
    history.resources(); history.usageSamples(); history.ownerTraces(); history.currentWindows(); history.completeWeekCount('weekly');
  }
  t.mock.restoreAll();
  assert.deepEqual({entries, imports}, calls);
  assert.deepEqual(bytes(directory), before);
});
test('C5: nested history preview cannot replace admission working state or persist its mutated returned metadata', async t => {
  const {createLendingHistory} = await callbackModules();
  const directory = callbackDirectory(t);
  let hook = null;
  const history = createLendingHistory({home: directory, account: 'claude', now: () => NOW,
    ledger: {entries() { hook?.(); return []; }}});
  history.bootstrapFromSessionLogs({readWeeklyUsage: () => [importRow()]});
  hook = () => {
    const scores = history.weeklyScores('weekly');
    scores.values().next().value.calibration_window.sentinel = 'preview-local';
  };
  history.record({window_id: 'weekly', window_minutes: 10080, resets_at: NOW + 604_800_000,
    observed_at: NOW, used_pct: 5, state: 'open',
    censoring: {complete: true, limit_reached: false, owner_refused: false, owner_deferred: false}});
  const saved = JSON.parse(fs.readFileSync(join(directory, 'v1/lending-history-claude.json'), 'utf8'));
  assert.equal(saved.bootstrap[0].calibration_window.sentinel, 'untouched',
    'preview rows must not be retained in the writer closure and later serialized by an admission-side record');
  assert.equal(saved.readings.length, 1);
});
// CALLBACK-AUDIT-END
// Supplemental excerpt witnesses: execute only supplied verbatim lines, never app.mjs.
function wiringExcerpt(start, end) {
  const text = fs.readFileSync(new URL('./fixtures/preview-callbacks.txt', import.meta.url), 'utf8');
  return text.split('\n').flatMap(line => {
    const match = /^(\d+): (.*)$/.exec(line);
    return match && Number(match[1]) >= start && Number(match[1]) <= end ? [match[2]] : [];
  }).join('\n');
}
test('C6: supplied objective excerpt reaches network queue callbacks despite snapshotOnly', async () => {
  const calls = {client: 0, offers: 0, queue: 0};
  const device = {async client() { calls.client++; return {async *listOffers() { calls.offers++; yield {job_digest: 'other'}; }}; }};
  const compile = options => Function('settings', 'options', 'device',
    wiringExcerpt(2479, 2549) + '\nreturn objectiveInputFor;')({limits: {lendingPolicy: {}}}, options, device);
  const evidence = {snapshotOnly: true, now: NOW, request: {circle: 'fixture', job_id: 'preview', provider: 'claude'}, context: {automatic: true}};
  assert.equal((await compile({})(evidence)).refuse, 'queue_unknown');
  assert.deepEqual(calls, {client: 1, offers: 1, queue: 0});
  const routeEvidence = {...evidence, request: {...evidence.request, circle: null}};
  assert.equal((await compile({})(routeEvidence)).refuse, 'queue_unknown');
  assert.deepEqual(calls, {client: 1, offers: 1, queue: 0}, 'default route without a circle does not call the network');
  assert.equal((await compile({lendingQueueReader: async () => { calls.queue++; return null; }})(routeEvidence)).refuse, 'queue_unknown');
  assert.equal(calls.queue, 1, 'injected queue reader executes even on no-circle route input');
});
test('C7: supplied historyFor excerpt populates a shared Map and exposes live history methods', async t => {
  const {createLendingHistory} = await callbackModules();
  const home = callbackDirectory(t), ledger = {entries: () => []};
  const result = Function('options', 'home', 'meterLedger', 'now', 'createLendingHistory',
    wiringExcerpt(2372, 2378) + '\nreturn {histories, historyFor};')({}, home, ledger, () => NOW, createLendingHistory);
  const before = bytes(home);
  assert.equal(result.histories.size, 0);
  const history = result.historyFor('claude');
  assert.equal(result.histories.size, 1, 'cold callback changes admission-shared history cache');
  assert.strictEqual(result.historyFor('claude'), history, 'warm callback returns a live mutable API object');
  assert.equal(typeof history.bootstrapFromSessionLogs, 'function');
  assert.equal(typeof history.record, 'function');
  assert.deepEqual(bytes(home), before, 'constructor reads are not a durable write');
});

// Owner-run integration cases: excluded lending-prices.json prevents local runtime import.
test('C8: real history, origin, owner-setting and override callbacks preserve files across many runtime previews', async t => {
  const f = await setup(t, {realCallbacks: true});
  await f.warm();
  const cache = f.runtime.candidate.observeSnapshot(args), before = await f.settled();
  for (let i = 0; i < 40; i++) assert.equal((await f.runtime.previewAdmission(offer(), {ownerAbsent: false})).admitted, true);
  const outcomes = await Promise.all(Array.from({length: 40}, () => f.runtime.previewAdmission(offer(), {ownerAbsent: false})));
  assert.ok(outcomes.every(out => out.admitted));
  assert.deepEqual(await f.settled(), before);
  assert.strictEqual(f.runtime.candidate.observeSnapshot(args), cache);
  assert.strictEqual(await f.warm(), cache, 'preview never invalidates the observation cache');
  // warm() queued two cache-hit observation rows; settle them into the baseline so the comparison covers only the preview.
  const afterWarm = await f.settled();
  const check = await f.runtime.previewAdmission(offer(), {ownerAbsent: false});
  assert.equal(check.admitted, true);
  assert.deepEqual(await f.settled(), afterWarm, 'real-callback preview wrote capture rows after the cache-hit observation settled');
  assert.strictEqual(f.runtime.candidate.observeSnapshot(args), cache);
});
test('C9: real callback previews interleaved with a real admission preserve the admission result and bytes', {timeout: 10_000}, async t => {
  const f = await setup(t, {realCallbacks: true});
  await f.warm();
  const started = deferred(), release = deferred();
  let waiting = 0;
  f.setHook(async ({snapshotOnly}) => {
    if (snapshotOnly) { if (++waiting === 24) started.resolve(); await release.promise; }
  });
  const previews = Array.from({length: 24}, (_, i) => f.runtime.previewAdmission(offer(`real-callback-preview-${i}`), {ownerAbsent: true}));
  await started.promise;
  const before = f.runtime.pace50.state();
  const job = offer('real-callback-admission');
  assert.equal((await f.runtime.reserve({provider: 'claude', model, job, jobId: job.id,
    attemptId: job.id, automatic: true, ownerAbsent: true, intentOn: true})).ok, true);
  assert.equal(f.runtime.pace50.state().revision, before.revision + 1);
  const after = await f.settled();
  release.resolve();
  assert.ok((await Promise.all(previews)).every(out => !out.admitted && out.reasonCode === 'objective_evidence_unknown'));
  assert.deepEqual(await f.settled(), after);
  assert.equal(f.runtime.pace50.state().attempts.length, 1);
});
test('C10: opted-in injected buildInput is unsandboxed but default-off preview never invokes it', async t => {
  let calls = 0;
  const buildInput = () => { calls++; return ordinaryInput({now: NOW}); };
  const f = await setup(t, {buildInput});
  const before = await f.settled();
  await f.runtime.previewAdmission(offer(), {ownerAbsent: true});
  assert.equal(calls, 1);
  assert.deepEqual(await f.settled(), before, 'preview wrote capture rows');
  const closed = await setup(t, {buildInput, readOnlyPreview: false});
  const closedBefore = await closed.settled();
  await closed.runtime.previewAdmission(offer(), {ownerAbsent: true});
  assert.equal(calls, 1);
  assert.deepEqual(await closed.settled(), closedBefore, 'preview wrote capture rows');
});
