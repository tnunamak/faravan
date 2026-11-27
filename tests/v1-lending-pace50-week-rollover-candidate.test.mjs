import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {transitionEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, DAY_MS, HOUR_MS, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';

const HAIKU = 'claude-haiku-5-5';
const WEEK2 = `${ACCOUNT}:weekly:${NOW + 42 * HOUR_MS + 60_000 + 7 * DAY_MS}`;
// The ordinary fixture resets weekly at NOW + 42 h and short at NOW + 1.25 h.
// The native carry fixture aligns both resets and reserves near them so no short period is skipped.
const WEEKLY_RESET = NOW + 42 * HOUR_MS;
const SWITCH = WEEKLY_RESET + 60_000;
const job = (expiresAt) => ({requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(expiresAt).toISOString()});
// The provider's week turns over at SWITCH: both windows become new instances under WEEK2.
function weekSwitchSource(native = false, used = {weekly: 0, short: 0}) {
  return createSyntheticPace50Source({start: NOW, accountWeek: WEEK,
    // The native carry scenario reserves near the weekly boundary, with both scopes ending there.
    ...(native ? {resets: {weekly: 42 * HOUR_MS, short: 42 * HOUR_MS}} : {}), kappa: {weekly: MICRO, short: MICRO},
    override: ({base, now}) => {
      if (native) base = {...base, resources: base.resources.map(r => ({...r,
        conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null}))};
      return now < SWITCH ? base : {...base, account_week_id: WEEK2, epoch: 'epoch-2', resources: [
      {...base.resources[0], instance: 'synthetic-weekly-2', anchor_at: SWITCH, resets_at: SWITCH + 7 * DAY_MS,
        duration_ms: 7 * DAY_MS, used_micro:used.weekly, observed_at: now},
      {...base.resources[1], instance: 'synthetic-short-2', anchor_at: SWITCH, resets_at: SWITCH + 5 * HOUR_MS,
        duration_ms: 5 * HOUR_MS, used_micro:used.short, observed_at: now},
    ]}; }});
}

test('a late start after the weekly reset carries its exposure into the verified successor week', {timeout: 60000}, async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'late-week-carry-'));
  const clock = {at: WEEKLY_RESET - 2 * HOUR_MS};
  const source = weekSwitchSource(true);
  const pace = createPace50Candidate({postingLagBoundMs:120000,directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source,
    pendingRecords: () => [], ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}});
  t.after(async () => { await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const id = 'late-week-start';
  assert.equal((await pace.candidate.reserve({attemptId:id,jobId:id,provider:'claude',model:HAIKU,
    job:job(WEEKLY_RESET),automatic:true,ownerAbsent:true})).ok,true);
  await pace.candidate.recordCleanup(id,{removed:true});
  clock.at = SWITCH + 1000;
  await pace.candidate.started(id,{ok:true});
  await pace.candidate.recordCleanup(id,{removed:true});
  const transitions = [];
  const transition = pace.adapter.transition.bind(pace.adapter);
  pace.adapter.transition = async (event, options) => {
    const before = pace.adapter.state();
    const out = await transition(event, options);
    if (event.type === 'late_start_carried') transitions.push({before, event, out});
    return out;
  };
  await pace.candidate.probeHeld();
  assert.equal(transitions.length, 1, 'carryLate must emit a carry transition');
  const {before, event, out} = transitions[0];
  assert.equal(out.applied, true, `carry guard refused: ${out.reason}; epochs ${before.attempts[0].epoch} -> ${event.carries[0].resource.epoch}`);
  const carry = pace.adapter.state().attempts.find(a => a.id.startsWith(`${id}:carry:`));
  assert.ok(carry, 'the old hold must be durably carried into the successor window');
  assert.equal(carry.resources[0].instance, 'synthetic-weekly-2');
  const old = before.attempts.find(a => a.id === id);
  const successors = pace.adapter.state().attempts.filter(a => a.id.startsWith(`${id}:carry:`));
  assert.equal(successors.length, old.resources.length, 'every affected window retains its maximum');
  for (const successor of successors) {
    const resource = successor.resources[0];
    const from = old.resources.find(r => r.id === resource.id);
    assert.equal(successor.account_week_id, WEEK2);
    assert.equal(successor.epoch, 'epoch-2');
    assert.equal(resource.epoch, 'epoch-2');
    assert.equal(resource.conversion, 'native_window');
    assert.equal(resource.unrepresented_micro, from.initial_micro);
  }
  assert.ok(pace.adapter.state().attempts.find(a => a.id === id).resources.every(r => r.held_micro === 0));
  const mutations = [
    ['missing identity', e => { delete e.identity_verified; }],
    ['another account', e => { e.account = 'other-account'; }],
    ['missing week mapping', e => { delete e.account_week_id; }],
    ['unchanged week', e => { e.account_week_id = WEEK; }],
    ['incomplete reading', e => { e.complete = false; }],
    ['failed refresh', e => { e.refresh_succeeded = false; }],
    ['stale reading', e => { e.observed_at -= 60001; }],
    ['mixed epochs', e => { e.carries[1].resource.epoch = 'unverified-epoch'; }],
    ['overlapping week', e => { e.carries[0].resource.anchor_at = WEEKLY_RESET - 1; }],
  ];
  for (const [name, mutate] of mutations) {
    await t.test(name + ' retains the old exposure', () => {
      const invalid = structuredClone(event);
      mutate(invalid);
      const result = transitionEstimatedPace50State(before, invalid);
      assert.equal(result.applied, false);
      assert.deepEqual(result.state, before, 'refusal must retain every old liability');
    });
  }
  for (const covered of ['short', 'weekly']) {
    await t.test(`only ${covered} covered transfers that maximum and retains the other hold`, () => {
      const partial = {...event, carries: event.carries.filter(c => c.resource.kind === covered)};
      const result = transitionEstimatedPace50State(before, partial);
      assert.equal(result.applied, true, result.reason);
      assert.equal(result.state.attempts.length, before.attempts.length + 1);
      for (const r of result.state.attempts.find(a => a.id === id).resources)
        assert.equal(r.held_micro, r.kind === covered ? 0 : r.initial_micro);
    });
  }
  await t.test('cleanup before the late acknowledgement cannot authorize a weekly carry', () => {
    const unproven = structuredClone(before);
    unproven.attempts.find(a => a.id === id).cleanup_proven = false;
    unproven.attempts.find(a => a.id === id).cleanup_proof_persisted_at = null;
    const result = transitionEstimatedPace50State(unproven, event);
    assert.equal(result.applied, false);
    assert.deepEqual(result.state, unproven);
  });
  await t.test('a reading before durable cleanup retains the old exposure', () => {
    const invalid = {...event, observed_at: before.attempts.find(a => a.id === id).cleanup_proof_persisted_at - 1};
    assert.equal(transitionEstimatedPace50State(before, invalid).applied, false);
  });
  const durable = pace.adapter.state();
  await pace.adapter.close();
  const reopened = createPace50Candidate({postingLagBoundMs:120000,directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source});
  assert.deepEqual(reopened.adapter.state(), durable, 'successor liabilities survive restart');
  await reopened.adapter.close();
});

// The account's week changes at a weekly reset while an old run still holds exposure. The verified change is persisted through
// admission, the old hold is preserved until its reset settles it, and the change and the settlement both survive a restart.
test('a verified account-week change with an outstanding hold: the hold settles once at its reset, and the change survives restart',
  {timeout: 60000}, async (t) => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'week-rollover-candidate-'));
    const clock = {at: NOW};
    const source = weekSwitchSource();
    const open = () => createPace50Candidate({postingLagBoundMs:120000,directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source,
      pendingRecords: () => []});
    let pace = open();
    t.after(async () => {
      await pace.adapter.close();
      fs.rmSync(directory, {recursive: true, force: true});
    });

    const oldAttempt = 'held-from-week-1';
    const row = () => pace.adapter.state().attempts.find((a) => a.id === oldAttempt);
    const reserved = await pace.candidate.reserve({attemptId: oldAttempt, jobId: 'old-week-job', provider: 'claude', model: HAIKU,
      job: job(NOW + 2 * HOUR_MS), automatic: true, ownerAbsent: true});
    assert.equal(reserved.ok, true, JSON.stringify(reserved));
    await pace.candidate.started(oldAttempt, {ok: true});
    // The sandbox is proven gone; the usage is not settled yet, so the hold is outstanding.
    await pace.candidate.recordCleanup(oldAttempt, {removed: true});
    const held = row().resources.map((r) => r.held_micro);
    assert.ok(held.every((value) => value > 0), 'the old run holds exposure before the change');

    clock.at = SWITCH;
    const refused = await pace.candidate.reserve({attemptId: 'new-week-attempt', jobId: 'new-week-job', provider: 'claude',
      model: HAIKU, job: job(SWITCH + HOUR_MS), automatic: true, ownerAbsent: true});
    assert.equal(pace.adapter.state().account_week_id, WEEK2, 'admission persists the verified week change');
    assert.equal(refused.ok, false, 'the old exposure is not dropped, so the new week waits for its reset');
    assert.equal(refused.policyReason, 'cross_window_exposure_unreconciled', JSON.stringify(refused));
    assert.deepEqual(row().resources.map((r) => r.held_micro), held, 'the old hold is unchanged by the refusal');

    await pace.adapter.close();
    pace = open();
    assert.equal(pace.adapter.state().account_week_id, WEEK2, 'a reopen with the old initial week keeps the new week');
    assert.deepEqual(row().resources.map((r) => r.held_micro), held, 'the old hold is durable across the restart');

    await pace.candidate.probeHeld();
    assert.deepEqual(row().resources.map((r) => r.held_micro), [0, 0], 'the reset settles the old hold');
    assert.deepEqual(row().resources.map((r) => r.spent_micro), held, 'the held amount is charged once, in full');
    const revision = pace.adapter.state().revision;
    await pace.candidate.probeHeld();
    assert.equal(pace.adapter.state().revision, revision, 'a second probe does not settle the hold again');

    const admitted = await pace.candidate.reserve({attemptId: 'after-reset', jobId: 'after-reset-job', provider: 'claude',
      model: HAIKU, job: job(SWITCH + HOUR_MS), automatic: true, ownerAbsent: true});
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
  });

// The same change on an idle store, with no hold outstanding: the first admission after the reset persists the new week and
// admits, and the new week survives a restart whichever week the reopened candidate is given.
test('an idle store admits after a verified account-week change, and the new week survives a restart',
  {timeout: 60000}, async (t) => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'week-rollover-idle-'));
    const clock = {at: NOW};
    const source = weekSwitchSource();
    const open = (accountWeek) => createPace50Candidate({directory, now: () => clock.at, account: ACCOUNT, account_week_id: accountWeek,
      source, pendingRecords: () => []});
    let pace = open(WEEK);
    t.after(async () => {
      await pace.adapter.close();
      fs.rmSync(directory, {recursive: true, force: true});
    });

    clock.at = SWITCH;
    const first = await pace.candidate.reserve({attemptId: 'idle-week-attempt', jobId: 'idle-week-job', provider: 'claude', model: HAIKU,
      job: job(SWITCH + HOUR_MS), automatic: true, ownerAbsent: true});
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(pace.adapter.state().account_week_id, WEEK2, 'admission persists the verified week change');
    await pace.candidate.release('idle-week-attempt', {reason: 'test', prepared: false});

    await pace.adapter.close();
    pace = open(WEEK2);
    assert.equal(pace.adapter.state().account_week_id, WEEK2, 'a reopen with the new initial week keeps the new week');
    const again = await pace.candidate.reserve({attemptId: 'idle-week-again', jobId: 'idle-week-again-job', provider: 'claude',
      model: HAIKU, job: job(SWITCH + 2 * HOUR_MS), automatic: true, ownerAbsent: true});
    assert.equal(again.ok, true, JSON.stringify(again));
  });
