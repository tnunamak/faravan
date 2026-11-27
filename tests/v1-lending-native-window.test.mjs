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
  const adapter = createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK, now: () => NOW, buildInput: () => p, decide: yes, effects});
  t.after(async () => { await adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const admitted = await adapter.admit({request: p.request, expectedRevision: 0});
  assert.equal(admitted.admitted, true);
  assert.equal(order.length, 1, 'launched once');
  assert.ok(order[0].attempts[0].resources.every(r => r.conversion === 'native_window' && r.held_micro > 0), 'persisted before launch');
});

// Design test 2 (admission half).
test('a meter from outside its quota window gives a named hold, not learning', () => {
  const stale = nativeFixture();
  for (const w of stale.windows) w.observed_at = NOW - 24 * 60 * 60_000;
  for (const w of stale.objective.ruleEvidence.snapshot.windows) w.observed_at = NOW - 24 * 60 * 60_000;
  const out = quote(stale);
  assert.equal(out.admitted, false);
  assert.notEqual(out.reason, 'conversion_unknown');
  const status = lendingStatus({reason: out.reason, reasonCode: out.objective?.reasonCode});
  assert.match(status.line, /^Holding|^Lending is waiting|^Waiting/);
  assert.doesNotMatch(status.line, /learning/);
  // The live guard's stale stop is named the same way.
  assert.equal(lendingStatus({reason: 'native_guard_meter_stale'}).line, LINES.measured);
  // An unreadable meter in readiness never shows the learning line.
  const checks = lendingReadiness({signedIn: true, sandboxState: 'passed', provider: 'claude',
    observation: {refresh_succeeded: false, resources: [{conversion: 'native_window', kappa_micro: null}], learning: [{reason: 'learning', provider: 'claude', window: 'weekly'}]}});
  assert.ok(checks.every(c => !/allowance points/.test(c.line ?? '') && !c.note));
});

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

test('the watchdog keeps a quietly read job alive, and stops it on reset, identity, funding or owner stop', async () => {
  for (const [label, patch, reason] of [
    ['reset', {resources: [{id: 'weekly', instance: 'weekly-2', resets_at: NOW + 10 * 86_400_000, used_micro: 0}]}, 'window_reset'],
    ['identity', {identity: {verified: true, account_id: 'someone-else'}}, 'identity_changed'],
    ['funding', {funding: {subscription_only: 'unknown', reason: 'extra_usage_enabled'}}, 'funding_changed'],
    ['epoch', {epoch: 'epoch-2'}, 'epoch_changed']]) {
    const clock = fakeTime(), stops = [];
    let next = 'quiet';
    const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
      read: async () => next === 'quiet' ? reading(clock.now(), 21 * M) : reading(clock.now(), 21 * M, patch),
      stop: (id, why) => stops.push(why)});
    watched(guard);
    await clock.advanceTo(NOW + 10 * 60_000);
    assert.deepEqual(stops, [], `${label}: fresh readings keep a quiet job alive past the freshness bound`);
    next = 'changed';
    await clock.advanceTo(NOW + 12 * 60_000);
    assert.deepEqual(stops, [reason], label);
  }
  const clock = fakeTime(), stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => reading(clock.now(), 21 * M), stop: (id, why) => stops.push(why)});
  watched(guard);
  guard.ownerStop('a1');
  await clock.advanceTo(NOW + 1);
  assert.deepEqual(stops, ['owner_stop']);
});

test('sub-second reset jitter across a second keeps a live Claude window attributable', async t => {
  const resetAt = 1_794_034_799_967;
  let readCount = 0, knownWindows = [];
  const identity = {account_sha256_16: '0123456789abcdef', email_sha256_16: 'fedcba9876543210'};
  const source = createRealPace50Source({
    readings: async () => {
      const observed_at = resetAt - 86_400_000 + readCount * 1_000;
      const resets_at = readCount++ === 0 ? resetAt : 1_794_034_800_120;
      return {windows: [{window_id: 'seven_day', window_minutes: 10080, used_pct: readCount === 1 ? 20 : 21,
        resets_at, observed_at, state: 'open'}]};
    },
    funding: async () => ({observed_at: resetAt - 86_400_000 + (readCount - 1) * 1_000, identity,
      extra_usage: 'disabled', guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}}),
    expectedIdentity: async () => ({account_sha256_16: identity.account_sha256_16}),
  });
  const first = await source.observe({provider: 'claude'});
  assert.equal(first.refresh_succeeded, true);
  knownWindows = first.resources.map(r => ({...r, epoch: first.epoch}));
  const second = await source.observe({provider: 'claude', knownWindows});
  const original = first.resources[0];
  const corrected = second.resources[0];
  const clock = fakeTime(second.observed_at ?? resetAt - 86_400_000);
  const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => second, stop: (id, reason) => stops.push([id, reason])});
  const reservation = {epoch: first.epoch, resources: [{id: original.id, instance: original.instance,
    anchor_at: original.anchor_at, resets_at: original.resets_at, baseline_used_micro: original.used_micro,
    initial_micro: 10 * M}]};
  guard.watch({attemptId: 'jitter', provider: 'claude', accountId: identity.account_sha256_16, epoch: reservation.epoch,
    resources: reservation.resources.map(r => ({...r})), lastFreshAt: first.observed_at});
  const offered = guard.offer('jitter', second);
  t.after(() => guard.unwatch('jitter'));

  assert.equal(offered.stopped, false, 'jitter does not halt the running job');
  assert.deepEqual(stops, []);
  assert.equal(second.epoch, reservation.epoch, 'the reading stays in the admitted weekly epoch');
  assert.deepEqual([corrected.instance, corrected.anchor_at, corrected.resets_at],
    [original.instance, original.anchor_at, original.resets_at], 'the meter row still matches the durable window');
  assert.ok(corrected.used_micro > reservation.resources[0].baseline_used_micro, 'the second read shows attributable use');
  const sample = lentCalibrationSamples({attempt: {...reservation, id: 'jitter', cleanup_proof_persisted_at: first.observed_at,
    resources: reservation.resources.map(r => ({...r, conversion: 'native_window'}))}, reading: second, usdMicro: 2 * M,
    provider: 'claude', model: 'claude-sonnet-5-5', accountId: identity.account_sha256_16, now: clock.now()});
  assert.equal(sample.samples.length, 1, 'the second read still yields a calibration sample');
});

test('with several weekly windows, each jittered window keeps its own saved instance', async t => {
  const weekReset = 1_794_034_799_967, shortReset = weekReset - 86_400_000 + 7_200_950;
  let readCount = 0;
  const identity = {account_sha256_16: '0123456789abcdef', email_sha256_16: 'fedcba9876543210'};
  const source = createRealPace50Source({
    readings: async () => {
      const observed_at = weekReset - 86_400_000 + readCount * 1_000, shift = readCount++ === 0 ? 0 : 160;
      return {windows: [
        {window_id: 'seven_day_sonnet', window_minutes: 10080, used_pct: 4, resets_at: weekReset + 400 + shift, observed_at, state: 'open'},
        {window_id: 'seven_day', window_minutes: 10080, used_pct: 20, resets_at: weekReset + shift, observed_at, state: 'open'},
        {window_id: 'five_hour', window_minutes: 300, used_pct: 3, resets_at: shortReset + shift, observed_at, state: 'open'}]};
    },
    funding: async () => ({observed_at: weekReset - 86_400_000 + (readCount - 1) * 1_000, identity,
      extra_usage: 'disabled', guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}}),
    expectedIdentity: async () => ({account_sha256_16: identity.account_sha256_16}),
  });
  const first = await source.observe({provider: 'claude'});
  // Saved rows may carry the attempt's epoch; each window must still keep its own instance.
  const second = await source.observe({provider: 'claude', knownWindows: first.resources.map(r => ({...r, epoch: first.epoch}))});
  const instances = observation => Object.fromEntries(observation.resources.map(r => [r.id, r.instance]));

  assert.deepEqual(instances(second), instances(first), 'every window keeps its own instance across the jitter');
  assert.ok(second.resources.every(r => r.instance.startsWith(`${r.id}@`)), 'no window takes another window\'s instance');
  assert.notEqual(instances(first).seven_day, instances(first).seven_day_sonnet);
  assert.equal(second.epoch, first.epoch);
  const clock = fakeTime(second.observed_at);
  const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => second, stop: (id, reason) => stops.push([id, reason])});
  guard.watch({attemptId: 'weeks', provider: 'claude', accountId: identity.account_sha256_16, epoch: first.epoch,
    resources: first.resources.map(r => ({id: r.id, instance: r.instance, anchor_at: r.anchor_at, resets_at: r.resets_at,
      baseline_used_micro: r.used_micro, initial_micro: 10 * M})), lastFreshAt: first.observed_at});
  const offered = guard.offer('weeks', second);
  await clock.advanceTo(clock.now());
  t.after(() => guard.unwatch('weeks'));
  assert.deepEqual(stops, []);
  assert.equal(offered.stopped, false);
});

test('a genuine weekly reset from the real source changes epoch and stops the job', async t => {
  const firstReset = 1_794_034_799_967;
  let readCount = 0, knownWindows = [];
  const identity = {account_sha256_16: '0123456789abcdef', email_sha256_16: 'fedcba9876543210'};
  const source = createRealPace50Source({
    readings: async () => {
      const observed_at = firstReset - 86_400_000 + readCount * 1_000;
      const resets_at = readCount++ === 0 ? firstReset : firstReset + 7 * 86_400_000;
      return {windows: [{window_id: 'seven_day', window_minutes: 10080, used_pct: 20,
        resets_at, observed_at, state: 'open'}]};
    },
    funding: async () => ({observed_at: firstReset - 86_400_000 + (readCount - 1) * 1_000, identity,
      extra_usage: 'disabled', guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'}}),
    expectedIdentity: async () => ({account_sha256_16: identity.account_sha256_16}),
  });
  const first = await source.observe({provider: 'claude'});
  knownWindows = first.resources.map(r => ({...r, epoch: first.epoch}));
  const second = await source.observe({provider: 'claude', knownWindows});
  const clock = fakeTime(second.observed_at);
  const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => second, stop: (id, reason) => stops.push([id, reason])});
  guard.watch({attemptId: 'new-week', provider: 'claude', accountId: identity.account_sha256_16, epoch: first.epoch,
    resources: first.resources.map(r => ({id: r.id, instance: r.instance, resets_at: r.resets_at,
      baseline_used_micro: r.used_micro, initial_micro: 10 * M})), lastFreshAt: first.observed_at});
  const offered = guard.offer('new-week', second);
  await clock.advanceTo(clock.now());
  t.after(() => guard.unwatch('new-week'));

  assert.notEqual(second.epoch, first.epoch);
  assert.equal(offered.stopped, true);
  assert.deepEqual(stops, [['new-week', 'epoch_changed']]);
});

// Design test 3: an adversarial burner at the largest rate, read with lag and quantization, polled by the guard's own timers.
test('an adversarial fast burner stays within the derived bound q + R*(L+P+T) + B', async () => {
  const F = 60_000, L = 20_000, T = 5_000, readMs = 2_000, B = 0;
  const R = 2 * M / 60_000; // two points a minute, in micro-points per ms
  const P = F / 2 + readMs; // the guard's first poll waits F/2; each later read leaves room for twice the measured read time
  const bound = nativeOvershootBound({L, P, T, R, B});
  assert.equal(bound.certified, true);
  for (const certified of [true, false]) {
    for (const burstDelay of [0, 1, readMs + 1, 7_000]) {
      const clock = fakeTime(), baseline = 20 * M, allowance = 30 * M;
      let stopAt = null;
      // True use: idle until just after a poll, then the full rate R until T after the stop decision.
      const startAt = NOW + burstDelay;
      const use = at => Math.max(0, Math.min(at, stopAt === null ? at : stopAt + T) - startAt) * R;
      const shown = at => baseline + Math.floor(use(at - L) / M) * M; // the meter lags L and shows whole points
      const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
        bounds: () => certified ? bound : null,
        read: async () => { const at = clock.now(); await new Promise(r => clock.setTimer(r, readMs)); return reading(at, shown(at)); },
        stop: () => { stopAt ??= clock.now(); }});
      watched(guard, {allowance, baseline});
      await clock.advanceTo(NOW + 3 * 3_600_000);
      assert.ok(stopAt !== null, 'the guard stopped the burner');
      const overshoot = use(stopAt + T + 1) - allowance;
      assert.ok(overshoot <= bound.marginMicro, `overshoot ${overshoot} <= ${bound.marginMicro} (delay ${burstDelay}, certified ${certified})`);
      if (certified) assert.ok(overshoot <= 0, `a certified threshold keeps the burner inside the allowance (${overshoot})`);
    }
  }
});

// Design test 4.
test('unknown R, L or B: soft-cap admission and no numeric guarantee', () => {
  for (const unknown of [{R: null}, {L: null}, {B: null}, {}]) {
    const bound = nativeOvershootBound({P: 30_000, T: 5_000, R: 1, L: 0, B: 0, ...unknown, ...(Object.keys(unknown).length ? {} : {R: null, L: null, B: null})});
    assert.equal(bound.certified, false);
    assert.equal(bound.marginMicro, null, 'no number is printed for an uncertified bound');
    assert.deepEqual(nativeStopThreshold(10 * M, bound), {thresholdMicro: 10 * M, certified: false}, 'stops at the allowance itself');
  }
  // A certified margin larger than the allowance cannot make a negative threshold; it falls back to the soft cap.
  assert.deepEqual(nativeStopThreshold(M, nativeOvershootBound({L: 0, P: 0, T: 0, R: 0, B: 5 * M})), {thresholdMicro: M, certified: false});
  assert.equal(DIFFERENCE_QUANTIZATION_MICRO, M);
  // The admission copy names points and the live meter, never a percentage or dollar guarantee.
  const text = quote(nativeFixture()).objective.reasonText;
  assert.doesNotMatch(text, /guarantee|safe|\$|%/);
});

// Design tests 5 and 6: calibration filters.
const attemptFor = (patch = {}) => ({id: 'att-1', epoch: 'epoch-1', cleanup_proof_persisted_at: NOW,
  resources: [{id: 'seven_day', conversion: 'native_window', instance: 'w1', resets_at: NOW + 86_400_000, baseline_used_micro: 20 * M}], ...patch});
const settled = (patch = {}, used = 24 * M) => ({refresh_succeeded: true, complete: true, epoch: 'epoch-1', observed_at: NOW + 1_000,
  identity: {verified: true, account_id: ACCOUNT}, funding: {subscription_only: 'proven'},
  resources: [{id: 'seven_day', instance: 'w1', resets_at: NOW + 86_400_000, used_micro: used}], ...patch});
const sample = (over = {}) => lentCalibrationSamples({attempt: attemptFor(), reading: settled(), usdMicro: 2 * M, provider: 'claude',
  model: 'claude-sonnet-5-5', accountId: ACCOUNT, now: NOW, ...over});

test('a settled, aligned, plan-funded lent job gives an upper-envelope rate; zero rise never gives a zero rate', () => {
  const ok = sample();
  assert.equal(ok.samples.length, 1);
  // k = (rise + q) / D, rounded up: (4 + 1) points over $2.
  assert.equal(ok.samples[0].upper_micro, Math.ceil(5 * M * M / (2 * M)));
  assert.equal(ok.samples[0].provenance.label, LENT_LABEL);
  assert.equal(ok.samples[0].binding.account_sha256_16, ACCOUNT);
  for (const used of [20 * M, 20 * M + M / 2])
    assert.deepEqual(sample({reading: settled({}, used)}).samples, [], 'below one shown point is no evidence, never zero');
  assert.deepEqual(sample({reading: settled({observed_at: NOW - 1})}).samples, [], 'a reading before the cleanup proof is unsettled');
});

test('API-paid or unknown funding, another account, a reset, a wrong model, a full meter or no price never calibrate', () => {
  const cases = {
    api: {reading: settled({funding: {subscription_only: 'disproven'}})},
    unknown_funding: {reading: settled({funding: {subscription_only: 'unknown'}})},
    other_account: {reading: settled({identity: {verified: true, account_id: 'ffffffffffffffff'}})},
    unverified: {reading: settled({identity: {verified: false, account_id: ACCOUNT}})},
    reset: {reading: settled({resources: [{id: 'seven_day', instance: 'w2', resets_at: NOW + 8 * 86_400_000, used_micro: 24 * M}]})},
    epoch: {reading: settled({epoch: 'epoch-2'})},
    censored: {reading: settled({}, 100 * M)},
    unpriced: {usdMicro: 0},
    unpriced_null: {usdMicro: null},
    model_family: {attempt: attemptFor({resources: [{id: 'seven_day_opus', conversion: 'native_window', instance: 'w1',
      resets_at: NOW + 86_400_000, baseline_used_micro: 20 * M}]}), reading: settled({resources: [{id: 'seven_day_opus', instance: 'w1',
      resets_at: NOW + 86_400_000, used_micro: 24 * M}]})},
    not_native: {attempt: attemptFor({resources: [{id: 'seven_day', conversion: 'measured', instance: 'w1', resets_at: NOW + 86_400_000, baseline_used_micro: 20 * M}]})},
  };
  for (const [label, over] of Object.entries(cases)) assert.deepEqual(sample(over).samples, [], label);
});

test('a replayed or copied settlement counts once, the store keeps the highest unexpired envelope, and expiry returns to native mode', t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-lent-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  let now = NOW + 1_000;
  const file = join(directory, 'lent.json');
  const store = createLentKappaStore({file, now: () => now});
  const first = sample().samples;
  assert.equal(store.record(first), true);
  assert.equal(store.record(first), false, 'the same attempt counts once');
  assert.equal(createLentKappaStore({file, now: () => now}).record(first), false, 'even after a restart');
  const lower = sample({attempt: attemptFor({id: 'att-2'}), reading: settled({}, 22 * M)}).samples;
  store.record(lower);
  assert.equal(store.current({accountId: ACCOUNT, resource: 'claude:seven_day'}).upper_micro, first[0].upper_micro, 'the highest envelope stays');
  assert.equal(store.current({accountId: 'ffffffffffffffff', resource: 'claude:seven_day'}), null, 'never for another account');
  now = first[0].expires_at;
  assert.equal(store.current({accountId: ACCOUNT, resource: 'claude:seven_day'}), null, 'expired: back to native mode, not a hold');
  assert.equal(first[0].expires_at - first[0].evidence_end_at, MEASUREMENT_MAX_AGE_MS);
});

// Design test 7.
test('restart, duplicate launch and concurrent admission keep the one cold hold; cleanup alone never settles it', async t => {
  const p = nativeFixture();
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-hold-'));
  const launches = [];
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window', 'cancel_pending_attempt',
    'request_cessation', 'request_fresh_complete_reconciliation'].map(type => [type, async e => {
    if (type === 'launch_chunk') launches.push(e); return type === 'arm_cessation_deadline' ? () => {} : undefined; }]));
  const instances = [];
  const open = () => { const a = createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK, now: () => NOW,
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
  const step = event => { const out = transitionEstimatedPace50State(state, event); assert.equal(out.applied, true, `${event.type}: ${out.reason}`); state = out.state; };
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
  const envelope = state.attempts[0].resources.map(r => r.initial_micro);
  step({type: 'native_meter_settled', event_id: 'settle', attempt_id: 'attempt-1', at: NOW + 122_000, observed_at: NOW + 122_000,
    account: ACCOUNT, epoch: 'epoch-1', complete: true, compatible: true, refresh_succeeded: true, usage: 'positive',
    resources: p.windows.map(w => ({id: w.id, instance: w.instance, anchor_at: w.anchor_at, resets_at: w.resets_at, used_micro: w.used_micro + 2 * M, uncertainty_micro:M}))});
  assert.deepEqual(state.attempts[0].resources.map(r => r.held_micro+r.unrepresented_micro), envelope,
    'a delayed partial rise preserves each original exposure');
  assert.ok(state.attempts[0].resources.every(r => r.spent_micro === 2 * M && r.released_micro === 0 && r.overshoot_micro === 0));
  const next = later(NOW + 123_000, 2 * M);
  assert.equal(next.admitted, false, JSON.stringify(next));
  assert.equal(next.reason, 'native_attempt_in_flight');
});

test('one shared meter rise cannot represent two attempts uncertainty steps', () => {
  const p = nativeFixture();
  const admitted = quote(p);
  assert.equal(admitted.admitted, true, admitted.reason);
  let state = structuredClone(admitted.proposed_state);
  const first = state.attempts[0];
  const shared = first.resources.find(resource => resource.id === 'short');
  assert.ok(shared);
  first.resources = [shared];
  const second = structuredClone(first);
  second.id = 'attempt-2';
  second.job_id = 'job-2';
  state.attempts.push(second);

  const apply = event => {
    const out = transitionEstimatedPace50State(state, event);
    assert.equal(out.applied, true, `${event.type}: ${out.reason}`);
    state = out.state;
  };
  for (const [index, attemptId] of ['attempt-1', 'attempt-2'].entries()) {
    const startedAt = NOW + 1 + index * 3;
    apply({type: 'launch_result', event_id: `${attemptId}:started`, attempt_id: attemptId, at: startedAt, result: 'started'});
    apply({type: 'cleanup_proven', event_id: `${attemptId}:cleanup-proven:1`, attempt_id: attemptId, at: startedAt + 1,
      cleanup_removed: true});
  }

  const short = p.windows.find(resource => resource.id === 'short');
  const meter = used => [{id: short.id, instance: short.instance, anchor_at: short.anchor_at, resets_at: short.resets_at,
    used_micro: used, uncertainty_micro: M}];
  for (const [attemptId, observedAt] of [['attempt-1', NOW + 120_100], ['attempt-2', NOW + 120_101]]) {
    apply({type: 'native_meter_settled', event_id: `${attemptId}:native-settle`, attempt_id: attemptId,
      at: observedAt, observed_at: observedAt, account: ACCOUNT, epoch: 'epoch-1', complete: true, compatible: true,
      refresh_succeeded: true, usage: 'positive', resources: meter(short.used_micro + M)});
  }

  for (const attempt of state.attempts) {
    const resource = attempt.resources[0];
    assert.equal(resource.unrepresented_micro, M);
    assert.deepEqual(resource.burns.filter(burn => !burn.represented).map(burn => burn.amount_micro), [M],
      `${attempt.id}'s uncertainty step remains an aggregate burn`);
    assert.equal(attempt.hold_closed, false);
  }

  // One more point is a visible rise. It is booked, but the reading cannot close either hold: neither attempt's uncertainty
  // step is released, and no attempt is closed by a single aggregate movement.
  const observedAt = NOW + 120_102;
  const out = transitionEstimatedPace50State(state, {type: 'native_meter_settled', event_id: 'attempt-1:cover-one-step',
    attempt_id: 'attempt-1', at: observedAt, observed_at: observedAt, account: ACCOUNT, epoch: 'epoch-1', complete: true,
    compatible: true, refresh_succeeded: true, usage: 'positive', resources: meter(short.used_micro + 2 * M)});
  assert.equal(out.applied, true, out.reason);
  assert.ok(out.state.attempts.every(attempt => attempt.hold_closed === false), 'one aggregate rise closes no hold');
  assert.ok(out.state.attempts.every(attempt => attempt.resources[0].released_micro === 0), 'no uncertainty step is released');
  assert.ok(out.state.attempts.every(attempt => attempt.resources[0].unrepresented_micro >= M),
    'neither attempt loses its unresolved exposure to the shared rise');
});

// Design test 8.
test('explicit owner controls still stop a native job: a zero strategy share or a per-job limit below one call', () => {
  for (const params of [{perJobPct: 0}, {fixedSharePct: 0, keepPct: 0}]) {
    const zero = nativeFixture();
    zero.objective = {...zero.objective, strategy: params.fixedSharePct === 0 ? 'fixed_share' : 'automatic', strategyParams: params};
    const held = quote(zero);
    assert.equal(held.admitted, false, JSON.stringify(params));
    assert.match(held.objective.reasonCode, /strategy_limit$/, JSON.stringify(params));
  }
  // A strategy share below the free room is the reserve: it is not widened to the window's remaining points.
  const share = nativeFixture();
  share.objective = {...share.objective, strategy: 'fixed_share', strategyParams: {fixedSharePct: 5, keepPct: 0}};
  const capped = quote(share);
  assert.equal(capped.admitted, true);
  const weeklyHeld = capped.proposed_state.attempts[0].resources.find(r => r.id === 'weekly').held_micro;
  assert.ok(weeklyHeld <= 5 * M, `weekly reserve ${weeklyHeld} is within the 5-point share`);
  const small = nativeFixture();
  small.objective = {...small.objective, ownerMaxJobUsdMicro: 1};
  const tiny = quote(small);
  assert.equal(tiny.admitted, false);
  assert.match(tiny.objective.reasonCode, /budget_too_small$/);
});

// Design test 9.
test('no legacy ledger and no guessed plan prior reaches native admission', async () => {
  for (const file of ['lender-pace50.mjs', 'lending-pace50-source.mjs', 'lending-native-guard.mjs', 'lending-kappa-lent.mjs'])
    assert.doesNotMatch(fs.readFileSync(new URL(`../lib/v1/${file}`, import.meta.url), 'utf8'), /lending-ledger\.mjs/, file);
  const out = quote(nativeFixture());
  assert.ok(out.proposed_state.attempts[0].resources.every(r => r.kappa_micro === null));
});

// Design test 10 (status copy; the mounted Setup check is in ui/v1/src/setup-mounted.test.mjs).
test('status shows lending-while-learning distinctly from a telemetry hold', () => {
  const lending = lendingStatus({admitted: true, active: true, conversion: 'native_window'});
  assert.equal(lending.id, 'learning');
  assert.equal(lending.line, "Lending now in allowance points · no measured usage rate yet.");
  const ready = lendingStatus({admitted: true, reasonCode: 'objective_lend_native'});
  assert.equal(ready.id, 'learning_ready');
  for (const reason of ['native_guard_meter_stale', 'refresh_failed', 'reading_stale']) {
    const hold = lendingStatus({reason});
    assert.equal(hold.id, 'measured', reason);
    assert.doesNotMatch(hold.line, /learning/);
  }
  assert.equal(lendingStatus({reason: 'native_attempt_in_flight'}).id, 'native_pending');
  for (const line of Object.values(LINES)) assert.doesNotMatch(line, /measuring|hasn't recorded the use/);
});

test('an unresolved Claude reservation does not block native Codex admission', () => {
  const named = p => JSON.parse(JSON.stringify(p, (key, value) => key === 'kind' ? value
    : value === 'weekly' ? 'seven_day' : value === 'short' ? 'five_hour' : value)
    .replaceAll('"weekly":', '"seven_day":').replaceAll('"short":', '"five_hour":'));
  const first = quote(named(nativeFixture()));
  assert.equal(first.admitted, true, first.reason);
  const codex = JSON.parse(JSON.stringify(named(nativeFixture({provider:'codex', model:'gpt-6-sol'})))
    .replaceAll('seven_day', 'codex:10080').replaceAll('five_hour', 'codex:300'));
  codex.request.attempt_id = 'codex-next';
  codex.request.job_id = 'codex-next';
  codex.account_week_id = `${ACCOUNT}:weekly:${codex.windows[0].resets_at}`;
  const advanced = transitionEstimatedPace50State(first.proposed_state, {type:'advance_account_week',
    event_id:'codex-week', at:NOW, account:ACCOUNT, weekly_account_id:ACCOUNT, account_week_id:codex.account_week_id, account_week_mapping_known:true,
    weekly_resource_id:'codex:10080', weekly_resets_at:codex.windows[0].resets_at});
  assert.equal(advanced.applied, true, advanced.reason);
  codex.state = advanced.state;
  const next = quote(codex);
  assert.equal(next.admitted, true, next.reason);
  const sameProvider = named(nativeFixture());
  sameProvider.state = first.proposed_state;
  sameProvider.request.attempt_id = 'claude-next';
  sameProvider.request.job_id = 'claude-next';
  assert.equal(quote(sameProvider).reason, 'native_attempt_in_flight');
});

test('an unreadable lent envelope is unknown: record refuses, the bytes survive and the app can tell', t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-lent-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const file = join(directory, 'lent.json');
  for (const bytes of ['{"version":1,"rows":{"claude', JSON.stringify({version: 2, rows: {}})]) {
    fs.writeFileSync(file, bytes);
    const store = createLentKappaStore({file, now: () => NOW + 1_000});
    assert.equal(store.unknown, true);
    assert.equal(store.current({accountId: ACCOUNT, resource: 'claude:seven_day'}), null);
    assert.throws(() => store.record(sample().samples), {code: 'state_unknown'});
    assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  }
  fs.rmSync(file);
  const fresh = createLentKappaStore({file, now: () => NOW + 1_000});
  assert.equal(fresh.unknown, false, 'a missing file is absent, not unknown');
  assert.equal(fresh.record(sample().samples), true);
});
