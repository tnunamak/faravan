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
// The admission, launch, cleanup and meter settlement of one native job on a pure policy state.
function settleJob(state, {attemptId, at, rise, usage = 'positive', p}) {
  const step = event => { const out = transitionEstimatedPace50State(state, event, {postingLagBoundMs:120000}); assert.equal(out.applied, true, `${event.type}: ${out.reason}`); state = out.state; };
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
test('whole growth plus uncertainty counts against the strategy share', () => {
  const objective = {strategy: 'fixed_share', strategyParams: {fixedSharePct: 20, keepPct: 0, perJobPct: 5}};
  let state = createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK});
  const first = admitAt(state, {at: NOW, consumed: 0, objective});
  assert.equal(first.weeklyHeld, 5 * M);
  state = settleJob(first.out.proposed_state, {attemptId: first.attemptId, at: NOW + 1_000, rise: 12 * M});
  const one = state.attempts[0].resources.find(r => r.id === 'weekly');
  assert.equal(one.spent_micro, 13 * M);
  assert.equal(one.overshoot_micro, 0, 'the whole growth plus a step is already in spent');
  // Second job: 20 - 12 = 8 share points left, per-job 5 binds. It uses exactly its 5.
  const second = admitAt(state, {at: NOW + 122_000, consumed: 12 * M, objective});
  assert.equal(second.weeklyHeld, 5 * M);
  state = settleJob(second.out.proposed_state, {attemptId: second.attemptId, at: NOW + 123_000, rise: 5 * M});
  // Third job: 20 - 17 = 3 share points left. Without the overshoot debit it would see 10 lent and hold 5 (actual 22 > 20).
  const third = admitAt(state, {at: NOW + 244_000, consumed: 17 * M, objective});
  assert.ok(third.weeklyHeld <= 3 * M, `the third job holds ${third.weeklyHeld / M} points, within the 3 left of the share`);
});

test('overshoot is not counted twice against the physical meter', () => {
  // With no strategy share, the free room is the meter reading less open holds. The settled overshoot is already in the reading.
  let state = createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK});
  const objective = {strategy: 'automatic', strategyParams: {perJobPct: 50}};
  const first = admitAt(state, {at: NOW, consumed: 0, objective});
  state = settleJob(first.out.proposed_state, {attemptId: first.attemptId, at: NOW + 1_000, rise: first.weeklyHeld + 10 * M});
  const fresh = admitAt(createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK}),
    {at: NOW + 122_000, consumed: first.weeklyHeld + 10 * M, objective});
  const after = admitAt(state, {at: NOW + 122_000, consumed: first.weeklyHeld + 10 * M, objective});
  assert.equal(after.weeklyHeld, fresh.weeklyHeld-M, 'only one uncertainty step is added to the physical meter');
});

// Security P3 (usage 0 skips the one-point floor). The usage class comes from guest output, so a zero report is not proof.
// A candidate restarted on a directory that holds one started, cleaned-up native attempt.
async function restartedCandidate(t, {used, observe, backend = null, pendingRecords = () => [], at = NOW + 2_000, cleanup = true}) {
  const p = nativeFixture({used});
  const directory = fs.mkdtempSync(join(tmpdir(), 'native-review-'));
  const effects = Object.fromEntries(['arm_cessation_deadline', 'launch_chunk', 'open_short_window', 'cancel_pending_attempt',
    'request_cessation', 'request_fresh_complete_reconciliation'].map(type => [type, async () =>
    type === 'arm_cessation_deadline' ? () => {} : undefined]));
  let clock = NOW;
  const seed = createPace50Adapter({postingLagBoundMs:120000,directory, account: ACCOUNT, account_week_id: WEEK, now: () => clock, buildInput: () => p, decide: yes, effects});
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
  const opened = createPace50Candidate({postingLagBoundMs:120000,directory, now: () => at, account: ACCOUNT, account_week_id: WEEK, buildInput: () => p,
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
    before.map(r => r.kind==='short' ? [r.id,r.held_micro,r.released_micro] :
      [r.id,0,Math.max(0,r.held_micro-5*M)]), 'the mismatched short resource retains every held point');
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
    assert.equal(r.spent_micro, 3 * M);
    assert.equal(r.held_micro+r.unrepresented_micro, M);
  }
  const unchanged = structuredClone(f.adapter.state());
  await f.candidate.probeHeld();
  assert.equal(f.adapter.state().revision, unchanged.revision, 'an unchanged reading does not write another event');
  assert.deepEqual(f.adapter.state().event_ids, unchanged.event_ids);
});

// Security P3 (restart). After a restart nothing binds the job's stop, so the guard's stop must reach the backend's hard stop.
// Security P2 / money (c) (kappa poisoning). A lent job's USD comes from guest output, and no host-side source prices the job
// (the provider traffic goes from the sandbox through Docker's credential proxy; Faravan reads only the meter). So a lent sample
// may only raise a trusted rate; it can never lower one, and alone it never enables dollar mode.