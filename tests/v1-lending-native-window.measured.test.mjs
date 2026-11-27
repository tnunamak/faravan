import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createRealPace50Source} from '../lib/v1/lending-pace50-source.mjs';
import {createEstimatedPace50State, evaluateEstimatedPace50, transitionEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {createNativeGuard, nativeOvershootBound, nativeStopThreshold, DIFFERENCE_QUANTIZATION_MICRO} from '../lib/v1/lending-native-guard.mjs';
import {createLentKappaStore, lentCalibrationSamples, LENT_LABEL} from '../lib/v1/lending-kappa-lent.mjs';
import {MEASUREMENT_MAX_AGE_MS} from '../lib/v1/lending-kappa-measure.mjs';
import {LINES, lendingStatus} from '../lib/v1/lending-status-copy.mjs';
import {lendingReadiness} from '../lib/v1/lending-readiness.mjs';
import {NATIVE_WINDOW_WEIGHTS} from '../lib/v1/quota-registry.mjs';
import {ordinaryInput, request, weekly, short, NOW, ACCOUNT, WEEK, MICRO as M} from './helpers/pace50-fixtures.mjs';

// Native-window mode (design 1101): an account with no measured conversion lends at once in its own window points.
// Entirely synthetic evidence and effect handlers. No provider, browser, network or Docker.
const native = w => ({...w, conversion:'native_window', kappa_micro:null});
const yes = s => ({admit:true, lendable:Object.fromEntries(s.windows.map(w => [w.id,100])), reason:'Synthetic spare.'});
function nativeFixture({provider='claude', model='claude-sonnet-5-5', used={}} = {}) {
  const windows=[native(weekly(NOW,used.weekly!==undefined?{used_micro:used.weekly}:{})),
    native(short(NOW,used.short!==undefined?{used_micro:used.short}:{}))];
  const p=ordinaryInput({now:NOW,windows});
  p.state=createEstimatedPace50State({account:ACCOUNT,account_week_id:WEEK});
  p.request=request({requested_usd_micro:3*M,provider,model});
  p.objective.ruleDial=.5;
  p.objective.job={...p.objective.job,provider,model,requestedUsdMicro:3*M};
  p.objective.ruleEvidence={
    snapshot:{account:ACCOUNT,windows:p.windows.map(w=>({window_id:w.id,
      window_minutes:w.duration_ms/60_000,used_pct:w.used_micro/M,resets_at:w.resets_at,
      observed_at:NOW,state:'open',lent_pct:0,reserved_pct:0}))},
    applicableResources:{account:ACCOUNT,provider,model,complete:true,ids:p.windows.map(w=>w.id)},
    entries:[],history:[],roundingPoints:Object.fromEntries(p.windows.map(w=>[w.id,0])),
    lagBounds:Object.fromEntries(p.windows.map(w=>[w.id,{providerLagMs:0,maxPointsPerHour:0,
      provenance:'Synthetic synchronous bounded account.'}]))};
  p.objective.job.nativeCostBounds={unit:'usd',lower:3,upper:3};
  p.objective.ruleEvidence.quotaRegistry={version:'synthetic/1',complete:true,
    limits:p.windows.map(w=>({id:w.id,provider,unit:'quota_percent',capacity:100,
      durationMs:w.duration_ms,reset:{kind:'first-use'},scope:{kind:'account'},
      weights:{version:NATIVE_WINDOW_WEIGHTS,nativeUnit:'quota_percent',byModel:{}}}))};
  return p;
}
const quote = p => evaluateEstimatedPace50({...p,objective:{...p.objective,decide:yes}});


// A deterministic fake clock and timer queue. Reads resolve as microtasks, so the queue drains them between timers.
function fakeTime(start = NOW) {
  let t = start, seq = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, {at: t + Math.max(0, ms), fn}); return id; };
  const clearTimer = id => { timers.delete(id); };
  const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
  // Run every timer due by `until`, in time order, with the clock at each timer's due time.
  const advanceTo = async (until, onTick = null) => {
    for (;;) {
      await flush();
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]);
      t = next[1].at;
      onTick?.(t);
      next[1].fn();
      await flush();
    }
    t = until;
    onTick?.(t);
    await flush();
  };
  return {now: () => t, setTimer, clearTimer, advanceTo, pending: () => timers.size};
}
const reading = (at, used, patch = {}) => ({refresh_succeeded: true, complete: true, observed_at: at, epoch: 'epoch-1',
  identity: {verified: true, account_id: ACCOUNT}, funding: {subscription_only: 'proven'},
  resources: [{id: 'weekly', instance: 'weekly-1', resets_at: NOW + 3 * 86_400_000, used_micro: used}], ...patch});
const watched = (guard, {allowance = 10 * M, baseline = 20 * M, lastFreshAt = NOW} = {}) => guard.watch({attemptId: 'a1',
  provider: 'claude', accountId: ACCOUNT, epoch: 'epoch-1', lastFreshAt,
  resources: [{id: 'weekly', instance: 'weekly-1', resets_at: NOW + 3 * 86_400_000, baseline_used_micro: baseline, initial_micro: allowance}]});

// Design test 1.
test('no measured rate and a fresh compatible reading: a real point reserve is persisted, the guard is armed, and the job launches', async t => {
  const p = nativeFixture();
  const out = quote(p);
  assert.equal(out.admitted, true, out.reason);
  assert.equal(out.conversion, 'native_window');
  assert.equal(out.objective.reasonCode, 'objective_lend_native');
  assert.match(out.objective.reasonText, /^Lending now in allowance points · no measured usage rate yet\. Allowance: \d+ weekly points/);
  const types = out.effects.map(e => e.type);
  assert.ok(types.indexOf('persist_proposed_state_before_provider_action') < types.indexOf('arm_native_guard'));
  assert.ok(types.indexOf('arm_native_guard') < types.indexOf('launch_chunk'), 'the guard is armed before launch');
  const guard = out.effects.find(e => e.type === 'arm_native_guard');
  assert.ok(guard.allowance.length === 2 && guard.allowance.every(a => a.allowance_micro > 0 && Number.isSafeInteger(a.baseline_used_micro)));
  const attempt = out.proposed_state.attempts[0];
  assert.ok(attempt.resources.every(r => r.conversion === 'native_window' && r.kappa_micro === null && r.held_micro > 0),
    'a typed native reservation, never a faked rate');
  assert.ok(attempt.resources.every(r => r.held_micro === r.initial_micro));
  // Through the durable adapter: the reservation is on disk before the launch effect runs.
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-admit-'));
  const order = [];
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window', 'cancel_pending_attempt',
    'request_cessation', 'request_fresh_complete_reconciliation'].map(type => [type, async () => {
    if (type === 'launch_chunk') order.push(JSON.parse(fs.readFileSync(join(directory, 'lending-pace50-state.json'), 'utf8')));
    return type === 'arm_cessation_deadline' ? () => {} : undefined;
  }]));
  const adapter = createPace50Adapter({postingLagBoundMs:120000,directory, account: ACCOUNT, account_week_id: WEEK, now: () => NOW, buildInput: () => p, decide: yes, effects});
  t.after(async () => { await adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const admitted = await adapter.admit({request: p.request, expectedRevision: 0});
  assert.equal(admitted.admitted, true);
  assert.equal(order.length, 1, 'launched once');
  assert.ok(order[0].attempts[0].resources.every(r => r.conversion === 'native_window' && r.held_micro > 0), 'persisted before launch');
});

// Design test 2 (admission half).
// Design test 2 (watchdog half): no token events, a failing read and a hung read.
for (const [label, read] of [['failing', async () => { throw new Error('unreadable'); }], ['hung', () => new Promise(() => {})],
  ['account busy', async () => ({refresh_succeeded: false, reason: 'account_busy'})]]) {
  test(`the watchdog stops a job whose meter goes silent (${label} read), with no token events`, async () => {
    const clock = fakeTime(), stops = [];
    const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, read,
      stop: (id, reason) => stops.push([id, reason, clock.now()])});
    watched(guard);
    await clock.advanceTo(NOW + 59_999);
    assert.deepEqual(stops, [], 'within the freshness bound');
    await clock.advanceTo(NOW + 60_000);
    assert.deepEqual(stops, [['a1', 'meter_stale', NOW + 60_000]]);
    assert.equal(guard.status('a1').cessation_proven, false, 'a stop request is not cessation');
  });
}

// Design test 3: an adversarial burner at the largest rate, read with lag and quantization, polled by the guard's own timers.
// Design test 4.
// Design tests 5 and 6: calibration filters.
const attemptFor = (patch = {}) => ({id: 'att-1', epoch: 'epoch-1', cleanup_proof_persisted_at: NOW,
  resources: [{id: 'seven_day', conversion: 'native_window', instance: 'w1', resets_at: NOW + 86_400_000, baseline_used_micro: 20 * M}], ...patch});
const settled = (patch = {}, used = 24 * M) => ({refresh_succeeded: true, complete: true, epoch: 'epoch-1', observed_at: NOW + 1_000,
  identity: {verified: true, account_id: ACCOUNT}, funding: {subscription_only: 'proven'},
  resources: [{id: 'seven_day', instance: 'w1', resets_at: NOW + 86_400_000, used_micro: used}], ...patch});
const sample = (over = {}) => lentCalibrationSamples({attempt: attemptFor(), reading: settled(), usdMicro: 2 * M, provider: 'claude',
  model: 'claude-sonnet-5-5', accountId: ACCOUNT, now: NOW, ...over});

// Design test 7.
test('restart, duplicate launch and concurrent admission keep the one cold hold; cleanup alone never settles it', async t => {
  const p = nativeFixture();
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-hold-'));
  const launches = [];
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window', 'cancel_pending_attempt',
    'request_cessation', 'request_fresh_complete_reconciliation'].map(type => [type, async e => {
    if (type === 'launch_chunk') launches.push(e); return type === 'arm_cessation_deadline' ? () => {} : undefined; }]));
  const instances = [];
  const open = () => { const a = createPace50Adapter({postingLagBoundMs:120000,directory, account: ACCOUNT, account_week_id: WEEK, now: () => NOW,
    buildInput: () => p, decide: yes, effects}); instances.push(a); return a; };
  t.after(async () => { for (const a of instances) await a.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const adapter = open();
  const [one, two] = await Promise.all([adapter.admit({request: p.request, expectedRevision: 0}),
    adapter.admit({request: {...p.request, attempt_id: 'attempt-2', job_id: 'job-2'}, expectedRevision: 0})]);
  assert.equal([one, two].filter(r => r.admitted).length, 1, 'concurrent admission: one cold job');
  await adapter.close();
  const resumed = open();
  assert.equal(resumed.state().attempts.length, 1, 'the reservation is durable');
  const again = await resumed.preview({request: {...p.request, attempt_id: 'attempt-3', job_id: 'job-3'}});
  assert.equal(again.admitted, false);
  assert.equal(again.reason, 'native_attempt_in_flight', 'the full reservation still consumes headroom');
  assert.equal(launches.length, 1);
  // Cleanup proves the process gone but does not settle use: the hold stays until a meter reading after the proof.
  let state = resumed.state();
  const step = event => { const out = transitionEstimatedPace50State(state, event, {postingLagBoundMs:120000}); assert.equal(out.applied, true, `${event.type}: ${out.reason}`); state = out.state; };
  step({type: 'launch_result', event_id: 'started', attempt_id: 'attempt-1', at: NOW, result: 'started'});
  step({type: 'cleanup_proven', event_id: 'attempt-1:cleanup-proven:1', attempt_id: 'attempt-1', at: NOW + 1_000, cleanup_removed: true});
  assert.ok(state.attempts[0].resources.every(r => r.held_micro > 0), 'cleanup alone does not release the hold');
  // A later quote, with the meter read after the state's last change.
  const later = (at, rise = 0) => { const q = nativeFixture({used: {weekly: 20 * M + rise, short: 40 * M + rise}});
    q.now = at; q.request = {...q.request, attempt_id: `attempt-${at}`, job_id: `job-${at}`};
    for (const w of q.windows) w.observed_at = at;
    // The rule evidence carries the settled lending as lent points, as the production builder does.
    for (const w of q.objective.ruleEvidence.snapshot.windows) { w.observed_at = at; w.lent_pct = rise / M; }
    if (rise) q.objective.ruleEvidence.entries = q.windows.map(w => ({account: ACCOUNT, window_id: w.id, started_at: NOW, ended_at: NOW + 1_000,
      resets_at: w.resets_at, lent_pts: rise / M, attribution: 'exact', represented_at: NOW + 1_500}));
    return quote({...q, state}); };
  assert.equal(later(NOW + 1_500).reason, 'native_attempt_in_flight');
  const early = transitionEstimatedPace50State(state, {type: 'native_meter_settled', event_id: 'settle-early', attempt_id: 'attempt-1',
    at: NOW + 1_000, observed_at: NOW + 500, account: ACCOUNT, epoch: 'epoch-1', complete: true, compatible: true, refresh_succeeded: true,
    usage: 'positive', resources: p.windows.map(w => ({id: w.id, instance: w.instance, anchor_at: w.anchor_at, resets_at: w.resets_at, used_micro: w.used_micro + 2 * M, uncertainty_micro:M}))});
  assert.equal(early.applied, false, 'a reading before the cleanup proof cannot settle');
  step({type: 'native_meter_settled', event_id: 'settle', attempt_id: 'attempt-1', at: NOW + 122_000, observed_at: NOW + 122_000,
    account: ACCOUNT, epoch: 'epoch-1', complete: true, compatible: true, refresh_succeeded: true, usage: 'positive',
    resources: p.windows.map(w => ({id: w.id, instance: w.instance, anchor_at: w.anchor_at, resets_at: w.resets_at, used_micro: w.used_micro + 2 * M, uncertainty_micro:M}))});
  assert.ok(state.attempts[0].resources.every(r => r.held_micro === 0 && r.unrepresented_micro === M && r.spent_micro === 3 * M && r.overshoot_micro === 0));
  const next = later(NOW + 123_000, 2 * M);
  assert.equal(next.admitted, true, JSON.stringify(next));
});

// Design test 8.
// Design test 9.
// Design test 10 (status copy; the mounted Setup check is in ui/v1/src/setup-mounted.test.mjs).
test('a skipped carry contributes no calibration sample; an adjacent carry still can', () => {
  const attempt = attemptFor();
  attempt.id = 'owner:carry:seven_day:old';
  assert.deepEqual(sample({attempt}).samples, [], 'a legacy carry has unknown adjacency');
  attempt.resources[0].skipped_periods = 2;
  assert.deepEqual(sample({attempt}).samples, []);
  attempt.resources[0].skipped_periods = 0;
  assert.equal(sample({attempt}).samples.length, 1);
});

// A legacy full charge marks the attempt's usage unknown. Its remaining exposure was charged in full, so no later reading,
// even one covered by a measured posting bound, may reconcile it as native use.
test('a measured native reading cannot reconcile an attempt that took a legacy full charge', async t => {
  const p = nativeFixture();
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-legacy-charge-'));
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window', 'cancel_pending_attempt',
    'request_cessation', 'request_fresh_complete_reconciliation'].map(type => [type, async () =>
    type === 'arm_cessation_deadline' ? () => {} : undefined]));
  const adapter = createPace50Adapter({postingLagBoundMs: 120000, directory, account: ACCOUNT, account_week_id: WEEK, now: () => NOW,
    buildInput: () => p, decide: yes, effects});
  t.after(async () => { await adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  assert.equal((await adapter.admit({request: p.request, expectedRevision: 0})).admitted, true);
  let state = adapter.state();
  const options = {postingLagBoundMs: 120000};
  const step = event => { const out = transitionEstimatedPace50State(state, event, options); assert.equal(out.applied, true, `${event.type}: ${out.reason}`); state = out.state; };
  step({type: 'launch_result', event_id: 'started', attempt_id: 'attempt-1', at: NOW, result: 'started'});
  step({type: 'cleanup_proven', event_id: 'attempt-1:cleanup-proven:1', attempt_id: 'attempt-1', at: NOW + 1_000, cleanup_removed: true});
  step({type: 'legacy_cleanup_full_charge', event_id: 'attempt-1:legacy', attempt_id: 'attempt-1', at: NOW + 2_000, authoritative_cessation: true});
  assert.equal(state.attempts[0].usage_unknown, 'legacy_full_charge');
  const reading = {type: 'native_meter_settled', event_id: 'settle', attempt_id: 'attempt-1', at: NOW + 122_000, observed_at: NOW + 122_000,
    account: ACCOUNT, epoch: 'epoch-1', complete: true, compatible: true, refresh_succeeded: true, usage: 'positive',
    resources: p.windows.map(w => ({id: w.id, instance: w.instance, anchor_at: w.anchor_at, resets_at: w.resets_at, used_micro: w.used_micro + 2 * M, uncertainty_micro: M}))};
  const out = transitionEstimatedPace50State(state, reading, options);
  assert.equal(out.applied, false, 'a measured reading cannot reconcile legacy-charged usage');
  assert.equal(out.reason, 'usage_unknown');
  assert.deepEqual(out.state, state, 'the refusal changes nothing');
});
