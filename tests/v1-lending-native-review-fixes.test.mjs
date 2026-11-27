import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createEstimatedPace50State, evaluateEstimatedPace50, transitionEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {createNativeGuard} from '../lib/v1/lending-native-guard.mjs';
import {NATIVE_WINDOW_WEIGHTS} from '../lib/v1/quota-registry.mjs';
import {ordinaryInput, request, weekly, short, NOW, ACCOUNT, WEEK, MICRO as M} from './helpers/pace50-fixtures.mjs';

// Regression tests for the 1101 security and money reviews of native-window lending. Synthetic evidence only: no provider,
// browser, network or Docker. Each test names the review finding it closes.
const native = w => ({...w, conversion: 'native_window', kappa_micro: null});
const yes = s => ({admit: true, lendable: Object.fromEntries(s.windows.map(w => [w.id, w.id === 'short' ? 1 : 100])), reason: 'Synthetic spare.'});
function nativeFixture({at = NOW, used = {}, objective = {}} = {}) {
  const provider = 'claude', model = 'claude-sonnet-5-5';
  const windows = [native(weekly(NOW, {observed_at: at, ...(used.weekly !== undefined ? {used_micro: used.weekly} : {})})),
    native(short(NOW, {observed_at: at, ...(used.short !== undefined ? {used_micro: used.short} : {})}))];
  const p = ordinaryInput({now: at, windows});
  p.state = createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK});
  p.request = request({requested_usd_micro: 3 * M, provider, model});
  p.objective.ruleDial = .5;
  p.objective.job = {...p.objective.job, provider, model, requestedUsdMicro: 3 * M, nativeCostBounds: {unit: 'usd', lower: 3, upper: 3}};
  p.objective.ruleEvidence = {
    snapshot: {account: ACCOUNT, windows: p.windows.map(w => ({window_id: w.id, window_minutes: w.duration_ms / 60_000,
      used_pct: w.used_micro / M, resets_at: w.resets_at, observed_at: at, state: 'open', lent_pct: 0, reserved_pct: 0}))},
    applicableResources: {account: ACCOUNT, provider, model, complete: true, ids: p.windows.map(w => w.id)},
    entries: [], history: [], roundingPoints: Object.fromEntries(p.windows.map(w => [w.id, 0])),
    lagBounds: Object.fromEntries(p.windows.map(w => [w.id, {providerLagMs: 0, maxPointsPerHour: 0,
      provenance: 'Synthetic synchronous bounded account.'}])),
    quotaRegistry: {version: 'synthetic/1', complete: true, limits: p.windows.map(w => ({id: w.id, provider, unit: 'quota_percent',
      capacity: 100, durationMs: w.duration_ms, reset: {kind: 'first-use'}, scope: {kind: 'account'},
      weights: {version: NATIVE_WINDOW_WEIGHTS, nativeUnit: 'quota_percent', byModel: {}}}))}};
  Object.assign(p.objective, objective);
  return p;
}
const quote = p => evaluateEstimatedPace50({...p, objective: {...p.objective, decide: yes}});
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

// A deterministic fake clock. Reads resolve as microtasks, so the queue drains them between timers.
function fakeTime(start = NOW) {
  let t = start, seq = 0;
  const timers = new Map();
  const setTimer = (fn, ms) => { const id = ++seq; timers.set(id, {at: t + Math.max(0, ms), fn}); return id; };
  const clearTimer = id => { timers.delete(id); };
  const advanceTo = async until => {
    for (;;) {
      await flush();
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > until) break;
      timers.delete(next[0]); t = next[1].at; next[1].fn(); await flush();
    }
    t = until; await flush();
  };
  return {now: () => t, setTimer, clearTimer, advanceTo};
}
const hostReading = (at, used) => ({refresh_succeeded: true, complete: true, observed_at: at, epoch: 'e',
  identity: {verified: true, account_id: 'a'}, funding: {subscription_only: 'proven'},
  resources: [{id: 'five_hour', instance: 'i', resets_at: NOW + 3_600_000, used_micro: used}]});
const watchFiveHour = guard => guard.watch({attemptId: 'x', provider: 'claude', accountId: 'a', epoch: 'e', lastFreshAt: NOW,
  resources: [{id: 'five_hour', instance: 'i', resets_at: NOW + 3_600_000, baseline_used_micro: 10 * M, initial_micro: 5 * M}]});
// A borrower-forged in-band line: the baseline value, so it reports no rise.
const forged = [{window_id: 'five_hour', used_pct: 10, resets_at: null}];

// Security P1 (in-band meter forgery). The PoC (coldlend-1101/sec-poc.test.mjs) showed forged lines every 10 s kept the host
// meter unread for 30 min with no stop. Pass means safe: the host meter is still read and the job is stopped.
test('forged in-band meter lines cannot starve the host meter read or delay its stop', async () => {
  const clock = fakeTime(); let reads = 0; const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => { reads++; return hostReading(clock.now(), 90 * M); }, stop: (id, reason) => stops.push([reason, clock.now()])});
  watchFiveHour(guard);
  for (let i = 0; i < 180; i++) {
    await clock.advanceTo(clock.now() + 10_000);
    guard.offerInband('x', forged, clock.now());
  }
  assert.ok(reads >= 1, 'the host meter was read');
  assert.equal(stops.length, 1);
  assert.equal(stops[0][0], 'allowance_reached', 'the host reading stopped the job');
  assert.ok(stops[0][1] <= NOW + 30_000, `stopped at the first host poll (${stops[0][1] - NOW} ms)`);
});

test('forged in-band lines never refresh the stale deadline: a silent host meter still stops the job at F', async () => {
  const clock = fakeTime(); const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => ({refresh_succeeded: false, probe: {reason: 'account_busy'}}), stop: (id, reason) => stops.push([reason, clock.now()])});
  watchFiveHour(guard);
  for (let i = 0; i < 12; i++) {
    await clock.advanceTo(clock.now() + 10_000);
    guard.offerInband('x', forged, clock.now());
  }
  assert.deepEqual(stops, [['meter_stale', NOW + 60_000]]);
  assert.equal(guard.status('x').last_fresh_at, NOW, 'an in-band line is not a fresh reading');
});

test('an in-band line can still add a stop: a rise at the allowance stops the job', async () => {
  const clock = fakeTime(); const stops = [];
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => ({refresh_succeeded: false}), stop: (id, reason) => stops.push(reason)});
  watchFiveHour(guard);
  await clock.advanceTo(NOW + 5_000);
  const below = guard.offerInband('x', [{window_id: 'five_hour', used_pct: 14, resets_at: null}], clock.now());
  assert.equal(below.stopped, false);
  assert.equal(below.usable, false, 'an in-band line below the threshold is not a usable reading');
  guard.offerInband('x', [{window_id: 'five_hour', used_pct: 15, resets_at: null}], clock.now());
  await flush();
  assert.deepEqual(stops, ['allowance_reached']);
});

test('a host reading older than an in-band line is still used', async () => {
  const clock = fakeTime(); const stops = [];
  // The host read reports a reading taken 5 s before the read returns; an in-band line arrives in between.
  const guard = createNativeGuard({now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    read: async () => { guard.offerInband('x', forged, clock.now()); return hostReading(clock.now() - 5_000, 90 * M); },
    stop: (id, reason) => stops.push(reason)});
  watchFiveHour(guard);
  await clock.advanceTo(NOW + 20_000);
  guard.offerInband('x', forged, clock.now());
  await clock.advanceTo(NOW + 60_000);
  assert.deepEqual(stops, ['allowance_reached']);
});

// The admission, launch, cleanup and meter settlement of one native job on a pure policy state.
function settleJob(state, {attemptId, at, rise, usage = 'positive', p}) {
  const step = event => { const out = transitionEstimatedPace50State(state, event); assert.equal(out.applied, true, `${event.type}: ${out.reason}`); state = out.state; };
  step({type: 'launch_result', event_id: `${attemptId}:started`, attempt_id: attemptId, at, result: 'started'});
  step({type: 'cleanup_proven', event_id: `${attemptId}:cleanup-proven:1`, attempt_id: attemptId, at: at + 100, cleanup_removed: true});
  const attempt = state.attempts.find(a => a.id === attemptId);
  step({type: 'native_meter_settled', event_id: `${attemptId}:native-settle`, attempt_id: attemptId, at: at + 120_300, observed_at: at + 120_200,
    account: ACCOUNT, epoch: 'epoch-1', complete: true, compatible: true, refresh_succeeded: true, usage,
    resources: attempt.resources.map(r => ({id: r.id, instance: r.instance, anchor_at: r.anchor_at, resets_at: r.resets_at,
      used_micro: r.baseline_used_micro + rise, uncertainty_micro:M}))});
  return state;
}
const admitAt = (state, {at, consumed, objective}) => {
  const q = nativeFixture({at, used: {weekly: 20 * M + consumed, short: 0 + consumed}, objective});
  q.request = {...q.request, attempt_id: `attempt-${at}`, job_id: `job-${at}`};
  // The rule evidence carries the settled lending as lent points, as the production builder does.
  for (const w of q.objective.ruleEvidence.snapshot.windows) w.lent_pct = consumed / M;
  if (consumed) q.objective.ruleEvidence.entries = q.windows.map(w => ({account: ACCOUNT, window_id: w.id, started_at: NOW,
    ended_at: at - 1, resets_at: w.resets_at, lent_pts: consumed / M, attribution: 'exact', represented_at: at - 1}));
  const out = quote({...q, state});
  assert.equal(out.admitted, true, `${out.reason} ${out.objective?.reasonCode} ${out.objective?.ruleReasonCode}`);
  return {out, attemptId: q.request.attempt_id, weeklyHeld: out.proposed_state.attempts.at(-1).resources.find(r => r.id === 'weekly').held_micro};
};

// Money P1 (overshoot not debited). Fixed share 20, per job 5, keep 0. The first job uses 12 points: 5 held and spent, 7 over.
test('observed overshoot counts against the strategy share, so later admissions see all 12 points', () => {
  const objective = {strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: 0, perJobPct: 5}};
  let state = createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK});
  const first = admitAt(state, {at: NOW, consumed: 0, objective});
  assert.equal(first.weeklyHeld, 5 * M);
  state = settleJob(first.out.proposed_state, {attemptId: first.attemptId, at: NOW + 1_000, rise: 12 * M});
  const one = state.attempts[0].resources.find(r => r.id === 'weekly');
  assert.equal(one.spent_micro, 5 * M);
  assert.equal(one.overshoot_micro, 7 * M, 'the excess over the hold is recorded');
  // Second job: 20 - 12 = 8 share points left, per-job 5 binds. It uses exactly its 5.
  const second = admitAt(state, {at: NOW + 122_000, consumed: 12 * M, objective});
  assert.equal(second.weeklyHeld, 5 * M);
  state = settleJob(second.out.proposed_state, {attemptId: second.attemptId, at: NOW + 123_000, rise: 5 * M});
  // Third job: 20 - 17 = 3 share points left. Without the overshoot debit it would see 10 lent and hold 5 (actual 22 > 20).
  const third = admitAt(state, {at: NOW + 244_000, consumed: 17 * M, objective});
  assert.ok(third.weeklyHeld <= 3 * M, `the third job holds ${third.weeklyHeld / M} points, within the 3 left of the share`);
});

test('an overshoot keeps its unresolved envelope and blocks a second native admission', () => {
  let state = createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK});
  const objective = {strategy: 'automatic', strategyParams: {perJobPct: 50}};
  const first = admitAt(state, {at: NOW, consumed: 0, objective});
  state = settleJob(first.out.proposed_state, {attemptId: first.attemptId, at: NOW + 1_000, rise: first.weeklyHeld + 10 * M});
  const held = state.attempts[0].resources.find(r => r.id === 'weekly');
  assert.equal(held.held_micro+held.unrepresented_micro,held.initial_micro);
  assert.equal(held.released_micro,0);
  const candidate = nativeFixture({at: NOW + 122_000,
    used: {weekly: 20 * M + first.weeklyHeld + 10 * M, short: first.weeklyHeld + 10 * M}, objective});
  candidate.request = {...candidate.request, attempt_id: 'attempt-after-overshoot', job_id: 'job-after-overshoot'};
  const after = quote({...candidate, state});
  assert.equal(after.admitted,false,'an unresolved native exposure blocks another admission');
  assert.equal(after.reason,'native_attempt_in_flight');
});

// Security P3 (usage 0 skips the one-point floor). The usage class comes from guest output, so a zero report is not proof.
test('a guest-reported zero usage still pays the one-point settlement floor', () => {
  const state = createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK});
  const first = admitAt(state, {at: NOW, consumed: 0, objective: {}});
  const settled = settleJob(first.out.proposed_state, {attemptId: first.attemptId, at: NOW + 1_000, rise: 0, usage: 'zero'});
  for (const r of settled.attempts[0].resources) assert.equal(r.spent_micro, M, `${r.id} is charged one point`);
});

// A candidate restarted on a directory that holds one started, cleaned-up native attempt.
async function restartedCandidate(t, {used, observe, backend = null, pendingRecords = () => [], at = NOW + 2_000, cleanup = true}) {
  const p = nativeFixture({used});
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-review-'));
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window', 'cancel_pending_attempt',
    'request_cessation', 'request_fresh_complete_reconciliation'].map(type => [type, async () =>
    type === 'arm_cessation_deadline' ? () => {} : undefined]));
  let clock = NOW;
  const seed = createPace50Adapter({directory, account: ACCOUNT, account_week_id: WEEK, now: () => clock, buildInput: () => p, decide: yes, effects});
  assert.equal((await seed.admit({request: p.request, expectedRevision: 0})).admitted, true);
  await seed.transition({type: 'launch_result', event_id: 'started', attempt_id: 'attempt-1', at: NOW, result: 'started'},
    {expectedRevision: seed.state().revision});
  if (cleanup) {
    clock = NOW + 1_000;
    await seed.transition({type: 'cleanup_proven', event_id: 'attempt-1:cleanup-proven:1', attempt_id: 'attempt-1', at: NOW + 1_000,
      cleanup_removed: true}, {expectedRevision: seed.state().revision});
  }
  await seed.close();
  const timers = [];
  const opened = createPace50Candidate({directory, now: () => at, account: ACCOUNT, account_week_id: WEEK, buildInput: () => p,
    decide: yes, source: {observe}, backend, pendingRecords,
    nativeGuard: {setTimer: (fn, ms) => { timers.push({fn, ms}); return timers.length; }, clearTimer: () => {}}});
  t.after(async () => { await opened.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  opened.candidate.registry.entry('attempt-1').provider = 'claude';
  return {...opened, p};
}

// Money P2 (settlement scope substitution). A reading of a new short-window instance, before the old instance's recorded reset,
// with the same weekly epoch, must not settle as ordinary use of the old instance.
test('a settlement reading of another short-window instance does not settle or release the hold', async t => {
  const reading = {refresh_succeeded: true, complete: true, account_week_id: WEEK, epoch: 'epoch-1', observed_at: NOW + 121_000,
    identity: {verified: true, account_id: ACCOUNT}, funding: {subscription_only: 'proven'}};
  const f = await restartedCandidate(t, {used: {short: 0}, at: NOW + 121_000, observe: async () => {
    const w = weekly(NOW), s = short(NOW);
    return {...reading, resources: [{id: 'weekly', instance: w.instance, anchor_at: w.anchor_at, resets_at: w.resets_at, used_micro: w.used_micro + 4 * M},
      {id: 'short', instance: 'short-2', anchor_at: NOW, resets_at: NOW + 5 * 3_600_000, used_micro: M}]};
  }});
  const before = structuredClone(f.adapter.state().attempts[0].resources);
  await f.candidate.probeHeld();
  const attempt = f.adapter.state().attempts[0];
  assert.equal(attempt.hold_closed, false, 'the hold stays open on incompatible evidence');
  assert.deepEqual(attempt.resources.map(r => [r.id, r.held_micro, r.released_micro]),
    before.map(r => [r.id, r.held_micro, r.released_micro]), 'no held point is released');
});

test('a partial reading of the same instances charges use and retains the remaining exposure', async t => {
  const f = await restartedCandidate(t, {used: {short: 0}, at: NOW + 121_000, observe: async () => {
    const w = weekly(NOW), s = short(NOW);
    return {refresh_succeeded: true, complete: true, account_week_id: WEEK, epoch: 'epoch-1', observed_at: NOW + 121_000,
      identity: {verified: true, account_id: ACCOUNT}, funding: {subscription_only: 'proven'},
      resources: [{id: 'weekly', instance: w.instance, anchor_at: w.anchor_at, resets_at: w.resets_at, used_micro: w.used_micro + 2 * M, uncertainty_micro:M},
        {id: 'short', instance: s.instance, anchor_at: s.anchor_at, resets_at: s.resets_at, used_micro: 2 * M, uncertainty_micro:M}]};
  }});
  await f.candidate.probeHeld();
  const attempt = f.adapter.state().attempts[0];
  assert.equal(attempt.hold_closed, false);
  for(const r of attempt.resources) {
    assert.equal(r.spent_micro, Math.min(2 * M,r.initial_micro));
    assert.equal(r.held_micro+r.unrepresented_micro, r.initial_micro);
    assert.equal(r.released_micro,0);
  }
  const unchanged = structuredClone(f.adapter.state());
  await f.candidate.probeHeld();
  assert.equal(f.adapter.state().revision, unchanged.revision, 'an unchanged reading does not write another event');
  assert.deepEqual(f.adapter.state().event_ids, unchanged.event_ids);
});

// Security P3 (restart). After a restart nothing binds the job's stop, so the guard's stop must reach the backend's hard stop.
test('after a restart, the native guard stop reaches the backend hard stop for the orphaned sandbox', async t => {
  const reconciled = [];
  const backend = {reconcilePending: async (record, {signal} = {}) => { reconciled.push({record, aborted: signal?.aborted === true});
    return {removed: true, attemptId: record.attemptId}; }};
  const pending = [{attemptId: 'attempt-1', sandbox: 'sbx-attempt-1'}];
  // The restart is 2 min after the last durable reading, so the guard asks to stop at once (meter_stale).
  const f = await restartedCandidate(t, {cleanup: false, at: NOW + 120_000, backend, pendingRecords: () => pending,
    observe: async () => ({refresh_succeeded: false, probe: {reason: 'account_busy'}})});
  for (let i = 0; i < 5 && reconciled.length === 0; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.candidate.nativeGuard.status('attempt-1').stop_reason, 'meter_stale');
  assert.deepEqual(reconciled.map(r => r.record), pending, 'the orphaned sandbox is removed by the backend');
  assert.equal(f.candidate.registry.entry('attempt-1').cleanupRemoved, true, 'the removal is recorded as cleanup proof');
});

// Security P2 / money (c) (kappa poisoning). A lent job's USD comes from guest output, and no host-side source prices the job
// (the provider traffic goes from the sandbox through Docker's credential proxy; Faravan reads only the meter). So a lent sample
// may only raise a trusted rate; it can never lower one, and alone it never enables dollar mode.
test('a lent sample cannot lower a trusted rate or establish one alone', async () => {
  const {learnedConversion} = await import('../lib/v1/lending-kappa-lent.mjs');
  assert.equal(typeof learnedConversion, 'function');
  const row = (upper, method) => ({upper_micro: upper, binding: {account_sha256_16: ACCOUNT}, provenance: {method}});
  const logged = row(500_000, 'log'), poisoned = row(1, 'lent-job'), higher = row(900_000, 'lent-job');
  assert.equal(learnedConversion({logged: null, lent: poisoned}), null, 'a cold account stays in native points mode');
  assert.equal(learnedConversion({logged: null, lent: higher}), null, 'even a plausible lent rate alone is not trusted');
  assert.equal(learnedConversion({logged, lent: poisoned}), logged, 'a poisoned low sample never lowers the trusted rate');
  assert.equal(learnedConversion({logged, lent: higher}), higher, 'a higher lent sample only makes points per dollar more conservative');
  assert.equal(learnedConversion({logged, lent: null}), logged);
});
