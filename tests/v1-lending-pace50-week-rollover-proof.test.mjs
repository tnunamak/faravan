import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import * as policy from '../lib/v1/lending-policy.mjs';
import {parseCodexRateLimits} from '../lib/v1/lending-meter.mjs';
import {transitionEstimatedPace50State} from '../lib/v1/lending-policy.mjs';
import {RESET_JITTER_MS} from '../lib/v1/window-origin.mjs';
import {weeklyWindowIdentity} from '../lib/v1/lending-pace50-source.mjs';
import {createSyntheticPace50Source, SYNTHETIC_RESET} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, NOW, WEEK, DAY_MS, HOUR_MS} from './helpers/pace50-fixtures.mjs';

const RESET = NOW + SYNTHETIC_RESET.weekly;
const SHORT_RESET = NOW + SYNTHETIC_RESET.short;
const WEEK_MS = 7 * DAY_MS;

async function scene(t, {shortFirst = false, readBeforeAck = false, stableEpoch = false, firstUseGap = 0, noCleanup = false, weeklyFirst = false, coverage = 'all', bothReset = false, offGridShort = false} = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'weekly-carry-proof-'));
  const clock = {at: NOW};
  const weeklyReset = weeklyFirst ? SHORT_RESET - 2000 : bothReset ? SHORT_RESET : RESET;
  const mode = {partial: false, failed: false, fault: null, coverage: 'all'};
  const source = createSyntheticPace50Source({start: NOW, override: ({base, now}) => {
    const weeklyAnchor = now < weeklyReset ? weeklyReset - WEEK_MS : weeklyReset + Math.floor((now - weeklyReset) / WEEK_MS) * WEEK_MS;
    const firstShortUse = SHORT_RESET + (offGridShort ? firstUseGap : 0);
    const shortAnchor = now < SHORT_RESET ? SHORT_RESET - 5 * HOUR_MS
      : firstShortUse + Math.floor((now - firstShortUse) / (5 * HOUR_MS)) * 5 * HOUR_MS;
    const resources = base.resources.map(r => {
      const anchor = r.kind === 'weekly' ? weeklyAnchor : shortAnchor;
      return {...r, instance: `${r.id}:${anchor}`, anchor_at: anchor, resets_at: anchor + r.duration_ms,
        conversion: 'native_window', kappa_micro: null, kappa_lower_micro: null, used_micro: 0};
    });
    return {...base, ...weeklyWindowIdentity({resources, identity: base.identity}),
      ...(stableEpoch ? {epoch: 'meter-plan-epoch'} : {}), refresh_succeeded: !mode.failed, complete: !mode.partial,
      resources: mode.coverage === 'none' ? [] : mode.coverage !== 'all' ? resources.filter(r => r.kind === mode.coverage) : mode.partial ? resources.filter(r => r.kind === 'weekly') : resources};
  }});
  const io = {
    renameSync(from, to) {
      if (mode.fault === 'before') throw Object.assign(new Error('injected before rename'), {code: 'EIO'});
      return fs.renameSync(from, to);
    },
    fsyncDirectory(path) {
      if (mode.fault === 'after') throw Object.assign(new Error('injected after rename'), {code: 'EIO'});
      const fd = fs.openSync(path, 'r');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    },
  };
  const open = () => createPace50Candidate({directory, io, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source,
    pendingRecords: () => [], ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 10})}});
  const f = {...open(), clock, mode, source, directory, open, events: []};
  t.after(async () => { await f.adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const transition = f.adapter.transition.bind(f.adapter);
  f.adapter.transition = async (event, options) => {
    const state = f.adapter.state();
    const row = {state, event};
    if (event.type === 'late_start_carried') f.events.push(row);
    row.out = await transition(event, options);
    return row.out;
  };
  const reserved = await f.candidate.reserve({attemptId: 'late', jobId: 'late', provider: 'claude', model: 'claude-haiku-5-5',
    job: {requirements: {limits: {wall_seconds: 300}}, expires_at: new Date(NOW + HOUR_MS).toISOString()},
    automatic: true, ownerAbsent: true});
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  mode.coverage = coverage;
  if (weeklyFirst) {
    clock.at = weeklyReset + 1000;
    await f.candidate.started('late', {ok: true});
    await f.candidate.recordCleanup('late', {removed: true});
    await f.candidate.probeHeld();
    return f;
  }
  if (!shortFirst) {
    clock.at = SHORT_RESET + 1000;
    await f.candidate.started('late', {ok: true});
    await f.candidate.probeHeld();
  }
  clock.at = shortFirst ? SHORT_RESET + firstUseGap + 1000 : RESET + 1000;
  if (readBeforeAck) await source.observe({provider: 'claude', now: clock.at});
  await f.candidate.started('late', {ok: true});
  if (!noCleanup) await f.candidate.recordCleanup('late', {removed: true});
  await f.candidate.probeHeld();
  return f;
}

function weeklyEvent(f) {
  const row = f.events.findLast(x => x.event.at >= RESET && x.event.carries.some(c=>c.resource.kind==='weekly'));
  assert.ok(row, 'a complete successor read emits a weekly carry');
  return row;
}
function assertWeeklyCarried(f) {
  const original = f.adapter.state().attempts.find(a => a.id === 'late');
  assert.ok(original.resources.every(r => r.held_micro === 0 && r.unrepresented_micro === 0),
    'the weekly carry must clear residual old exposure after an earlier short carry');
  const successors = f.adapter.state().attempts.filter(a => a.id.startsWith('late:carry:')&&a.id.split(':carry:').length===2);
  assert.equal(successors.filter(a => a.resources[0].kind === 'short').length, 1, 'the short maximum is never duplicated');
  assert.equal(successors.filter(a => a.resources[0].kind === 'weekly').length, 1);
}

for (const [name, mutate] of [
  ['old epoch', (e, state) => { e.epoch = state.attempts[0].epoch; for (const c of e.carries) c.resource.epoch = e.epoch; }],
  ['foreign epoch', e => { e.epoch = 'foreign-epoch'; for (const c of e.carries) c.resource.epoch = e.epoch; }],
  ['older epoch', e => { e.epoch = 'older-week'; for (const c of e.carries) c.resource.epoch = e.epoch; }],
  ['wrong account week', e => { e.account_week_id = 'another-week'; }],
]) {
  test(`a rollover read before the acknowledgement cannot authorize ${name}`, async t => {
    const f = await scene(t, {readBeforeAck: true});
    const {state, event} = weeklyEvent(f);
    const invalid = structuredClone(event);
    mutate(invalid, state);
    const out = transitionEstimatedPace50State(state, invalid);
    assert.equal(out.applied, false, 'the weekly window must bind the exact epoch and account week');
    assert.deepEqual(out.state, state, 'a malformed carry cannot release the old hold');
    const mismatch = structuredClone(event);
    mismatch.epoch = 'mismatched-top-level';
    assert.equal(transitionEstimatedPace50State(state, mismatch).applied, false);
  });
}

test('a weekly carry after an earlier short carry retains each maximum exactly once', async t => {
  const f = await scene(t, {shortFirst: true});
  assert.equal(f.adapter.state().attempts.filter(a => a.id.includes(':carry:')).length, 1);
  f.clock.at = RESET + 1000;
  await f.adapter.transition({type:'late_ack',event_id:'weekly-liveness',attempt_id:'late',at:f.clock.at},{expectedRevision:f.adapter.state().revision});
  await f.candidate.recordCleanup('late',{removed:true});
  await f.candidate.probeHeld();
  assertWeeklyCarried(f);
  for (const boundary of ['before', 'after']) {
    const crash = await scene(t, {shortFirst: true});
    crash.clock.at = RESET + 1000;
    await crash.adapter.transition({type:'late_ack',event_id:'weekly-liveness',attempt_id:'late',at:crash.clock.at},{expectedRevision:crash.adapter.state().revision});
    await crash.candidate.recordCleanup('late',{removed:true});
    crash.mode.fault = boundary;
    await assert.rejects(crash.candidate.probeHeld(), {code: 'pace50_persist_failed'});
    const {state, event} = weeklyEvent(crash);
    await crash.adapter.close();
    crash.mode.fault = null;
    Object.assign(crash, crash.open());
    const disk = crash.adapter.state();
    if (boundary === 'before') assert.deepEqual(disk, state, 'a failed commit retains every original liability');
    else assertWeeklyCarried(crash);
    const replay = await crash.adapter.transition(event, {expectedRevision: disk.revision});
    assert.equal(replay.applied, boundary === 'before');
    if (boundary === 'after') assert.equal(replay.reason, 'duplicate_event');
    assertWeeklyCarried(crash);
  }
});

for (const failure of ['partial', 'failed']) {
  test(`a ${failure} rollover read holds until a complete successful retry after a short carry`, async t => {
    const f = await scene(t, {shortFirst: true, noCleanup: true});
    f.clock.at = RESET + 1000;
    await f.candidate.recordCleanup('late', {removed: true});
    f.mode[failure] = true;
    await f.candidate.probeHeld();
    const weekly = f.adapter.state().attempts[0].resources.find(r => r.kind === 'weekly');
    assert.ok(weekly.held_micro + weekly.unrepresented_micro > 0, 'missing proof keeps the weekly liability');
    f.mode[failure] = false;
    f.clock.at += 1000;
    await f.candidate.probeHeld();
    assertWeeklyCarried(f);
  });
}

test('two weekly rollovers settle the short and weekly successors without duplicate charges', async t => {
  const f = await scene(t, {shortFirst: true});
  f.clock.at = RESET + 1000;
  await f.adapter.transition({type:'late_ack',event_id:'weekly-liveness',attempt_id:'late',at:f.clock.at},{expectedRevision:f.adapter.state().revision});
  await f.candidate.recordCleanup('late',{removed:true});
  await f.candidate.probeHeld();
  assertWeeklyCarried(f);
  const maxima = f.adapter.state().attempts.filter(a => a.id.includes(':carry:')).map(a => a.resources[0].initial_micro);
  f.clock.at = RESET + WEEK_MS + 1000;
  await f.candidate.probeHeld();
  const successors = f.adapter.state().attempts.filter(a => a.id.includes(':carry:'));
  assert.deepEqual(successors.map(a => a.resources[0].spent_micro), maxima);
  assert.ok(successors.every(a => a.resources.every(r => r.held_micro === 0 && r.unrepresented_micro === 0)));
  const settled = f.adapter.state();
  await f.candidate.probeHeld();
  assert.deepEqual(f.adapter.state(), settled, 'another read cannot charge the settled successors again');
});

test('a malformed final carry cannot partially transfer the first resource', async t => {
  const f = await scene(t);
  const {state, event} = weeklyEvent(f);
  // A second residual resource verifies refusal remains atomic after considering a valid first row.
  const extraSource = structuredClone(state.attempts[0].resources.find(r => r.kind === 'weekly'));
  extraSource.id = 'seven_day_sonnet';
  extraSource.kind = 'model';
  state.attempts[0].resources.push(extraSource);
  const extraCarry = structuredClone(event.carries[0]);
  extraCarry.from_id = extraCarry.resource.id = extraSource.id;
  extraCarry.resource.kind = 'model';
  event.carries.push(extraCarry);
  const invalid = structuredClone(event);
  invalid.epoch = state.attempts[0].epoch;
  for (const carry of invalid.carries) carry.resource.epoch = invalid.epoch;
  // A valid-looking final row must not let the old epoch bypass the weekly proof.
  invalid.carries.at(-1).resource.used_micro = 1;
  const out = transitionEstimatedPace50State(state, invalid);
  assert.equal(out.applied, false, 'carry epochs must match the verified reading');
  assert.deepEqual(out.state, state, 'both old holds remain when the last carry has no valid weekly proof');
  const finalInvalid = structuredClone(event);
  finalInvalid.carries.at(-1).resource.used_micro = 100_000_001;
  const partial = transitionEstimatedPace50State(state, finalInvalid);
  assert.equal(partial.applied, false, 'the final invalid row must refuse after the first row was considered');
  assert.deepEqual(partial.state, state, 'the first row cannot escape an atomic refusal');
});

test('the real carry builder takes weekly proof guards when the reading keeps its old epoch', async t => {
  const f = await scene(t, {stableEpoch: true});
  const successors = f.adapter.state().attempts.filter(a => a.id.includes(':carry:')&&a.id.split(':carry:').length===2);
  assert.ok(f.adapter.state().attempts.filter(a=>a.id.split(':carry:').length>2).every(a=>a.resources[0].unrepresented_micro===a.resources[0].initial_micro));
  const current = await f.source.observe({provider: 'claude', now: f.clock.at});
  assert.equal(successors.length, 2);
  const weekly = successors.find(a => a.resources[0].kind === 'weekly');
  const short = successors.find(a => a.resources[0].kind === 'short');
  assert.equal(weekly.account_week_id, current.account_week_id, 'the weekly successor uses the new reading week');
  assert.equal(short.account_week_id, f.adapter.state().attempts[0].account_week_id, 'the prior short carry retains its original week');
  assert.ok(successors.every(a => a.epoch === 'meter-plan-epoch'));
  const beforeCleanup = f.events.find(row => row.event.at >= RESET && row.event.carries.some(c=>c.resource.kind==='weekly') && row.state.attempts[0].cleanup_proven !== true);
  assert.equal(beforeCleanup.out.applied, false, 'unchanged epochs cannot bypass fresh cleanup');
  assert.deepEqual(transitionEstimatedPace50State(beforeCleanup.state, beforeCleanup.event).state, beforeCleanup.state);
  assert.equal(weekly.resources[0].unrepresented_micro, weekly.resources[0].initial_micro);
  assert.equal(short.resources[0].spent_micro, short.resources[0].initial_micro);
  assert.equal(short.resources[0].released_micro, 0);
});

// Provider weeks can start on first use, well after the preceding reset.
function delayedWeeklyEvent(f, gap, weeklyId = 'seven_day') {
  const row = weeklyEvent(f);
  const state = structuredClone(row.state);
  const event = structuredClone(row.event);
  const weekly = state.attempts[0].resources.find(r => r.kind === 'weekly');
  const previousId = weekly.id;
  weekly.id = weeklyId;
  const at = RESET + gap + 1000;
  state.updated_at = at;
  state.attempts[0].cleanup_proof_persisted_at = at;
  event.at = at;
  event.observed_at = at;
  for (const carry of event.carries) {
    if (carry.from_id === previousId) carry.from_id = carry.resource.id = weeklyId;
    const r = carry.resource;
    r.anchor_at += gap;
    r.resets_at += gap;
    r.instance = `${r.id}:${r.anchor_at}`;
  }
  const target = event.carries.find(c => c.resource.kind === 'weekly').resource;
  event.account_week_id = `${state.account}:weekly:${target.resets_at}`;
  event.weekly_mapping = {...event.weekly_mapping, observed_at: at, resource_id: target.id,
    instance: target.instance, anchor_at: target.anchor_at, resets_at: target.resets_at,
    account_week_id: event.account_week_id};
  return {state, event};
}

for (const id of ['seven_day', 'codex:10080']) {
  for (const periods of [1, 2]) test(`${id} accepts a weekly carry after ${periods} full skipped periods`, async t => {
    const f = await scene(t);
    const {state, event} = delayedWeeklyEvent(f, periods * WEEK_MS, id);
    const out = transitionEstimatedPace50State(state, event);
    assert.equal(out.applied, true, out.reason);
    assert.equal(out.state.attempts.at(-1).resources[0].skipped_periods, periods);
  });

  test(`${id} accepts first use late within the next period and settles every maximum`, async t => {
    const f = await scene(t);
    const {state, event} = delayedWeeklyEvent(f, 0.9 * WEEK_MS, id);
    let out = transitionEstimatedPace50State(state, event);
    assert.equal(out.applied, true, out.reason);
    for (const successor of out.state.attempts.filter(a => a.id.includes(':carry:'))
      .sort((a, b) => a.resources[0].resets_at - b.resources[0].resets_at)) {
      out = transitionEstimatedPace50State(out.state, {type: 'window_reset_settled',
        event_id: `reset:${successor.id}`, attempt_id: successor.id,
        at: Math.max(out.state.updated_at, successor.resources[0].resets_at,
          out.state.attempts[0].cleanup_proof_persisted_at+successor.resources[0].duration_ms), resource_ids: [successor.resources[0].id], authoritative_cessation: true});
      assert.equal(out.applied, true, out.reason);
    }
    for (const attempt of out.state.attempts) for (const r of attempt.resources) {
      assert.deepEqual({held: r.held_micro, unrepresented: r.unrepresented_micro,
        spent: r.spent_micro, released: r.released_micro},
      {held: 0, unrepresented: 0, spent: r.initial_micro, released: 0}, `${attempt.id}: ${r.id}`);
    }
  });
}

// A meter outside the provider vocabulary declares no period, so its own window length stands in (skippedPeriods).
// The carry is accepted, and its exposure stays unrepresented until the durable bound; nothing is released.
test('a weekly carry with a meter outside the vocabulary uses its own window length and keeps the exposure', async t => {
  const f = await scene(t);
  const {state, event} = delayedWeeklyEvent(f, 0, 'unknown-week');
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, true, out.reason);
  const carry = out.state.attempts.find(a => a.id.includes(':carry:unknown-week:')).resources[0];
  assert.equal(carry.skipped_periods, 0);
  assert.equal(carry.unrepresented_micro, carry.initial_micro, 'the carried exposure is retained');
  assert.equal(carry.released_micro, 0);
});

function delayedShortEvent(f, gap) {
  const row = f.events.find(x => x.event.at < RESET);
  assert.ok(row, 'the short carry is observed');
  const cleanup = transitionEstimatedPace50State(row.state, {type: 'cleanup_proven',
    event_id: 'late:cleanup-proven:short-test', attempt_id: 'late', at: row.event.at, cleanup_removed: true});
  assert.equal(cleanup.applied, true, cleanup.reason);
  const state = cleanup.state;
  const event = structuredClone(row.event);
  event.at += gap;
  event.observed_at += gap;
  state.updated_at = event.at;
  state.attempts[0].cleanup_proof_persisted_at = event.at;
  for (const carry of event.carries) {
    carry.resource.anchor_at += gap;
    carry.resource.resets_at += gap;
    carry.resource.instance += `:delayed:${gap}`;
  }
  return {state, event};
}

test('a same-epoch short carry accepts a skipped five-hour window without releasing exposure', async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 5 * HOUR_MS);
  assert.equal(event.epoch, state.attempts[0].epoch);
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, true, out.reason);
  const carried = out.state.attempts.at(-1).resources[0];
  assert.equal(carried.skipped_periods, 1);
  assert.equal(carried.unrepresented_micro, carried.initial_micro);
  assert.equal(carried.released_micro, 0);
});

test('a same-epoch short carry accepts first use late within the next five-hour period', async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 0.9 * 5 * HOUR_MS);
  let out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, true, out.reason);
  const successor = out.state.attempts.at(-1);
  out = transitionEstimatedPace50State(out.state, {type: 'window_reset_settled', event_id: 'short-carry-reset',
    attempt_id: successor.id, at: Math.max(out.state.updated_at, successor.resources[0].resets_at,
          out.state.attempts[0].cleanup_proof_persisted_at+successor.resources[0].duration_ms), resource_ids: [successor.resources[0].id], authoritative_cessation: true});
  assert.equal(out.applied, true, out.reason);
  const resource = out.state.attempts.at(-1).resources[0];
  assert.deepEqual({held: resource.held_micro, unrepresented: resource.unrepresented_micro,
    spent: resource.spent_micro, released: resource.released_micro},
  {held: 0, unrepresented: 0, spent: resource.initial_micro, released: 0});
  for (const r of out.state.attempts[0].resources) {
    const short = r.kind === 'short';
    assert.deepEqual({held: r.held_micro, unrepresented: r.unrepresented_micro, spent: r.spent_micro, released: r.released_micro},
      {held: short ? 0 : r.initial_micro, unrepresented: 0, spent: short ? r.initial_micro : 0, released: 0}, r.id);
  }
});


test('the real carry builder survives two offline periods, restart and carry reset', async t => {
  const f = await scene(t, {shortFirst: true, firstUseGap: 10 * HOUR_MS});
  let state = f.adapter.state();
  assert.equal(state.attempts.length, 2, 'skipped periods create no ledger row');
  const carry = state.attempts.at(-1);
  const r = carry.resources[0];
  assert.equal(r.skipped_periods, 2);
  assert.equal(r.spent_micro, r.initial_micro);
  assert.equal(r.unrepresented_micro, r.initial_micro);
  assert.equal(r.released_micro, 0);
  await f.adapter.close();
  Object.assign(f, f.open());
  assert.deepEqual(f.adapter.state(), state);
  f.clock.at = r.resets_at;
  await f.candidate.probeHeld();
  state = f.adapter.state();
  const ended = state.attempts.find(a => a.id === carry.id).resources[0];
  assert.equal(ended.unrepresented_micro, 0);
  assert.equal(ended.spent_micro, r.initial_micro);
  assert.equal(ended.released_micro, 0);
});

test('a saved carry without skipped metadata loads and settles after skipped periods', async t => {
  const f = await scene(t, {shortFirst: true, firstUseGap: 10 * HOUR_MS});
  const state = f.adapter.state();
  assert.equal(state.attempts.length, 2);
  const carry = state.attempts.at(-1);
  delete carry.resources[0].skipped_periods;
  await f.adapter.close();
  fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(state));
  Object.assign(f, f.open());
  f.clock.at = carry.resources[0].resets_at;
  await f.candidate.probeHeld();
  const ended = f.adapter.state().attempts.find(a => a.id === carry.id).resources[0];
  assert.equal(ended.unrepresented_micro, 0);
  assert.equal(ended.spent_micro, ended.initial_micro);
});

test('skippedPeriods checks boundaries, vocabulary, ids and reset jitter', () => {
  const source = {id: 'five_hour', resets_at: NOW};
  for (const [gap, expected] of [[0, 0], [5 * HOUR_MS, 1], [10 * HOUR_MS, 2], [-30_000, 0], [-120_000, null]])
    assert.equal(policy.skippedPeriods(source, {id: source.id, anchor_at: NOW + gap}), expected);
  assert.equal(policy.skippedPeriods({id: 'unknown', resets_at: NOW}, {id: 'unknown', anchor_at: NOW}), null);
  assert.equal(policy.skippedPeriods(source, {id: 'seven_day', anchor_at: NOW}), null);
});

for (const [early, accepted] of [[30_000, true], [120_000, false]]) {
  test(`a short successor anchored ${early / 1000} seconds early ${accepted ? 'carries' : 'refuses'}`, async t => {
    const f = await scene(t, {shortFirst: true});
    const {state, event} = delayedShortEvent(f, 0);
    for (const c of event.carries) {
      c.resource.anchor_at -= early;
      c.resource.resets_at -= early;
    }
    const out = transitionEstimatedPace50State(state, event);
    assert.equal(out.applied, accepted, out.reason);
    if (accepted) assert.equal(out.state.attempts.at(-1).resources[0].skipped_periods, 0);
    else assert.deepEqual(out.state, state);
  });
}

test('a weekly rollover does not require a carry for an unreset short resource', async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 0);
  const short = state.attempts[0].resources.find(r => r.kind === 'short');
  // The weekly reset precedes the still-open short reset.
  event.at = event.observed_at = short.resets_at - 1000;
  state.updated_at = event.at;
  state.attempts[0].cleanup_proof_persisted_at = event.at;
  for (const late of state.attempts[0].late_ack_events) late.at = Math.min(late.at, event.at);
  const weekly = state.attempts[0].resources.find(r => r.kind === 'weekly');
  weekly.resets_at = event.at - 1000;
  weekly.anchor_at = weekly.resets_at - weekly.duration_ms;
  const successor = {...weekly, used_micro: 0, instance: 'next-week', anchor_at: weekly.resets_at,
    resets_at: weekly.resets_at + weekly.duration_ms};
  event.carries = [{from_id: weekly.id, from_instance: weekly.instance, resource: successor}];
  event.account = state.account;
  event.identity_verified = event.complete = event.refresh_succeeded = true;
  event.account_week_id = `${state.account}:weekly:${successor.resets_at}`;
  event.weekly_mapping = {account: state.account, account_week_id: event.account_week_id, epoch: event.epoch,
    observed_at: event.observed_at, resource_id: successor.id, instance: successor.instance,
    anchor_at: successor.anchor_at, resets_at: successor.resets_at};
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, true, out.reason);
  assert.equal(out.state.attempts[0].resources.find(r => r.kind === 'short').held_micro, short.initial_micro);
});

test('skipped metadata is valid only on a carry and must match its source', async t => {
  const f = await scene(t, {shortFirst: true});
  const state = f.adapter.state();
  const validate = s => transitionEstimatedPace50State(s, {type: '__validate__', event_id: 'validate-metadata', at: s.updated_at});
  for (const value of [1, -1, 0.5]) {
    const bad = structuredClone(state);
    bad.attempts.at(-1).resources[0].skipped_periods = value;
    assert.equal(validate(bad).reason, 'state_unknown');
  }
  const malformed = structuredClone(state);
  malformed.attempts.at(-1).id = 'unmatched-carry';
  malformed.attempts.push({resources: [null]});
  assert.equal(validate(malformed).reason, 'state_unknown');
  state.attempts[0].resources[0].skipped_periods = 0;
  assert.equal(validate(state).reason, 'state_unknown');
});

test('a successor retains the full maximum through reset until the original spending tree stops', async t => {
  const f=await scene(t,{shortFirst:true,noCleanup:true});
  const before=f.adapter.state(),carry=before.attempts.find(a=>a.id.includes(':carry:'));
  assert.equal(before.attempts[0].cleanup_proven,false);
  f.clock.at=carry.resources[0].resets_at;await f.candidate.probeHeld();
  const retained=f.adapter.state();
  const successors=retained.attempts.filter(a=>a.id.includes(':carry:')&&a.resources.some(r=>r.unrepresented_micro>0));
  assert.ok(successors.some(a=>a.resources[0].unrepresented_micro===carry.resources[0].initial_micro));
  assert.equal(retained.attempts[0].cleanup_proven,false);
  assert.notEqual(retained.attempts[0].process_state,'ceased');
  f.clock.at++;await f.candidate.recordCleanup('late',{removed:true});
  const ceased=f.clock.at;
  for(const successor of successors){
    const r=successor.resources[0];
    f.clock.at=Math.max(f.clock.at,Math.max(r.resets_at,ceased+r.duration_ms));
    await f.candidate.probeHeld();
    const settled=f.adapter.state().attempts.find(a=>a.id===successor.id);
    assert.equal(settled.resources[0].unrepresented_micro,0);
    assert.equal(settled.resources[0].spent_micro,carry.resources[0].initial_micro);
    assert.equal(settled.hold_closed,true);
  }
});

// Every case checks both sides of the transfer, durable restart, and the successor reset.
async function checkCarryCharges(f, before, event, after) {
  assert.equal(after.attempts.length, before.attempts.length + event.carries.length, 'no skipped-period rows');
  for (const c of event.carries) {
    const original = after.attempts.find(a => a.id === event.attempt_id);
    const source = original.resources.find(r => r.id === c.from_id && r.instance === c.from_instance);
    const target = after.attempts.find(a => a.id === `${original.id}:carry:${source.id}:${source.instance}`).resources[0];
    assert.deepEqual([source.spent_micro, source.held_micro, source.unrepresented_micro, source.released_micro],
      [source.initial_micro, 0, 0, 0]);
    assert.deepEqual([target.initial_micro, target.spent_micro, target.held_micro, target.unrepresented_micro, target.released_micro],
      [source.initial_micro, source.initial_micro, 0, source.initial_micro, 0]);
  }
  await f.adapter.close();
  fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(after));
  Object.assign(f, f.open());
  assert.deepEqual(f.adapter.state(), after, 'restart preserves all charges');
  let settled = f.adapter.state();
  for (const c of event.carries) {
    const id = `${event.attempt_id}:carry:${c.from_id}:${c.from_instance}`;
    const out = transitionEstimatedPace50State(settled, {type: 'window_reset_settled', event_id: `reset:${id}`,
      attempt_id: id, at: Math.max(settled.updated_at,c.resource.resets_at,settled.attempts[0].cleanup_proof_persisted_at+c.resource.duration_ms), resource_ids: [c.from_id], authoritative_cessation: true});
    assert.equal(out.applied, true, out.reason);
    settled = out.state;
    const r = settled.attempts.find(a => a.id === id).resources[0];
    assert.deepEqual([r.spent_micro, r.held_micro, r.unrepresented_micro, r.released_micro], [r.initial_micro, 0, 0, 0]);
    const source = settled.attempts.find(a => a.id === event.attempt_id).resources.find(r => r.id === c.from_id);
    assert.deepEqual([source.spent_micro, source.held_micro, source.unrepresented_micro, source.released_micro],
      [source.initial_micro, 0, 0, 0]);
    assert.equal(settled.attempts.length, after.attempts.length);
  }
  return settled;
}

for (const [name, make] of [
  ['whole weekly skips', f => delayedWeeklyEvent(f, 2 * WEEK_MS)],
  ['short skip', f => delayedShortEvent(f, 5 * HOUR_MS)],
  ['30 second overlap', f => {const row = delayedShortEvent(f, 0);
    for (const c of row.event.carries) {c.resource.anchor_at -= 30000; c.resource.resets_at -= 30000;} return row;}],
]) test(`carry charges survive restart and reset: ${name}`, async t => {
  const f = await scene(t);
  const {state, event} = make(f);
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, true, out.reason);
  await checkCarryCharges(f, state, event, out.state);
});

for (const restart of [false, true]) test(`partial coverage carries A and later B closes (restart=${restart})`, async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 0);
  const source = structuredClone(state.attempts[0].resources.find(r => r.kind === 'short'));
  source.id = 'seven_day_sonnet'; source.kind = 'model';
  state.attempts[0].resources.push(source);
  const second = structuredClone(event.carries[0]);
  second.from_id = second.resource.id = source.id; second.resource.kind = source.kind;
  const partial = transitionEstimatedPace50State(state, event);
  assert.equal(partial.applied, true, partial.reason);
  assert.equal(partial.state.attempts[0].resources.at(-1).held_micro, source.initial_micro);
  let retryState = partial.state;
  if (restart) {
    await f.adapter.close();
    fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(retryState));
    Object.assign(f, f.open()); retryState = f.adapter.state();
    assert.deepEqual(retryState, partial.state);
  }
  event.event_id += ':B'; event.at += 1000; event.observed_at += 1000;
  event.carries = [second];
  const full = transitionEstimatedPace50State(retryState, event);
  assert.equal(full.applied, true, full.reason);
  const ended = await checkCarryCharges(f, retryState, event, full.state);
  assert.equal(ended.attempts.find(a => a.resources[0].id === source.id).hold_closed, true, 'B has a reachable closer');
});

test('weekly-first carry followed by short reset closes every hold through restart', async t => {
  const f = await scene(t, {weeklyFirst: true});
  let state = f.adapter.state();
  const original = state.attempts[0];
  const weekly = original.resources.find(r => r.kind === 'weekly');
  const short = original.resources.find(r => r.kind === 'short');
  assert.equal(state.attempts.length, 2);
  assert.deepEqual([weekly.spent_micro, weekly.held_micro, weekly.unrepresented_micro, weekly.released_micro], [weekly.initial_micro, 0, 0, 0]);
  assert.equal(short.held_micro, short.initial_micro);
  const row = f.events.findLast(r => r.out?.applied);
  await checkCarryCharges(f, row.state, row.event, state);
  f.clock.at = short.resets_at + 1000;
  await f.candidate.probeHeld();
  state = f.adapter.state();
  assert.equal(state.attempts.length, 3, 'the existing weekly successor is reused');
  const shortCarry = state.attempts.at(-1).resources[0];
  assert.deepEqual([shortCarry.initial_micro, shortCarry.spent_micro, shortCarry.held_micro, shortCarry.unrepresented_micro, shortCarry.released_micro],
    [short.initial_micro, short.initial_micro, 0, short.initial_micro, 0]);
  assert.ok(state.attempts[0].resources.every(r => r.held_micro === 0 && r.unrepresented_micro === 0));
  await f.adapter.close(); Object.assign(f, f.open());
  assert.deepEqual(f.adapter.state(), state);
  f.clock.at = Math.max(...state.attempts.flatMap(a=>a.resources.map(r=>Math.max(r.resets_at,state.attempts[0].cleanup_proof_persisted_at+r.duration_ms))))+1000;
  await f.candidate.probeHeld();
  for (const a of f.adapter.state().attempts) {
    assert.equal(a.hold_closed, true, a.id);
    for (const r of a.resources) assert.deepEqual([r.spent_micro, r.held_micro, r.unrepresented_micro, r.released_micro], [r.initial_micro, 0, 0, 0]);
  }
});

test('fractional Codex periods keep exact ids and skipped-period boundaries', () => {
  for (const minutes of [299.5, 300.5, 300.6]) {
    const parsed = parseCodexRateLimits({primary: {window_minutes: minutes, used_percent: 10, resets_at: NOW / 1000 + 3600}}, NOW);
    const r = parsed.readings[0];
    assert.equal(r.window_id, `codex:${minutes}`);
    assert.equal(r.window_minutes, minutes);
    const source = {id: r.window_id, resets_at: NOW};
    assert.equal(policy.skippedPeriods(source, {id: r.window_id, anchor_at: NOW + minutes * 60000}), 1);
    assert.equal(policy.skippedPeriods(source, {id: r.window_id, anchor_at: NOW + minutes * 120000}), 2);
  }
});

for (const kinds of [['short'], ['weekly'], ['short', 'weekly']]) {
  test(`uncovered ${kinds.join('+')} settles at the cessation bound through restart`, async t => {
    const f = await scene(t, {shortFirst: true});
    const {state, event} = delayedShortEvent(f, 0);
    state.attempts[0].resources = state.attempts[0].resources.filter(r => kinds.includes(r.kind));
    const owner = state.attempts[0];
    for (const r of owner.resources) {r.resets_at = SHORT_RESET; r.anchor_at = r.resets_at - r.duration_ms;}
    const bound = Math.max(...owner.resources.map(r => owner.cleanup_proof_persisted_at + r.duration_ms));
    const reset = at => ({type: 'window_reset_settled', event_id: `bounded:${at}`, attempt_id: owner.id,
      at, resource_ids: owner.resources.map(r => r.id), authoritative_cessation: true});
    const early = transitionEstimatedPace50State(state, reset(bound - 1));
    assert.equal(early.applied, false, 'the covering instance is still open');
    assert.deepEqual(early.state, state);
    await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(state));
    Object.assign(f, f.open());
    const ended = transitionEstimatedPace50State(f.adapter.state(), reset(bound));
    assert.equal(ended.applied, true, ended.reason);
    assert.equal(ended.state.attempts.length, 1, 'no successor was observed or invented');
    assert.equal(ended.state.attempts[0].late_ack_unresolved, false);
    assert.equal(ended.state.attempts[0].hold_closed, true);
    for (const r of ended.state.attempts[0].resources)
      assert.deepEqual([r.spent_micro, r.held_micro, r.unrepresented_micro, r.released_micro], [r.initial_micro, 0, 0, 0]);
  });
}

for (const covered of ['short', 'weekly']) test(`both reset with only ${covered} covered carries that resource`, async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 0);
  const owner = state.attempts[0];
  const weekly = owner.resources.find(r => r.kind === 'weekly');
  weekly.resets_at = SHORT_RESET; weekly.anchor_at = SHORT_RESET - weekly.duration_ms;
  const target = {...event.carries[0].resource, id: weekly.id, kind: 'weekly', instance: 'next-week-partial',
    anchor_at: SHORT_RESET, resets_at: SHORT_RESET + weekly.duration_ms, duration_ms: weekly.duration_ms};
  if (covered === 'weekly') event.carries = [{from_id: weekly.id, from_instance: weekly.instance, resource: target}];
  event.account = state.account; event.identity_verified = event.complete = event.refresh_succeeded = true;
  event.account_week_id = `${state.account}:weekly:${target.resets_at}`;
  event.weekly_mapping = {account: state.account, account_week_id: event.account_week_id, epoch: event.epoch,
    observed_at: event.observed_at, resource_id: target.id, instance: target.instance, anchor_at: target.anchor_at, resets_at: target.resets_at};
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, true, out.reason);
  await checkCarryCharges(f, state, event, out.state);
});

test('a carry before the cessation bound wins exactly once and resolves zero exposure', async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 0);
  state.attempts[0].resources = state.attempts[0].resources.filter(r => r.kind === 'short');
  const carried = transitionEstimatedPace50State(state, event);
  assert.equal(carried.applied, true, carried.reason);
  assert.equal(carried.state.attempts[0].late_ack_unresolved, false);
  const again = transitionEstimatedPace50State(carried.state, {...event, event_id: 'second-carry'});
  assert.equal(again.applied, false);
  assert.deepEqual(again.state, carried.state);
  await checkCarryCharges(f, state, event, carried.state);
});

test('a spent zero-hold source cannot acquire a late successor while another resource waits', async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 0);
  const r = state.attempts[0].resources.find(r => r.kind === 'short');
  r.spent_micro = r.initial_micro; r.held_micro = 0;
  r.burns = [{id: 'already-spent', at: r.resets_at - 1, represented: true, amount_micro: r.initial_micro}];
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, false);
  assert.deepEqual(out.state, state);
});

test('an unknown cessation time never gets a clock-based bound', async t => {
  const f = await scene(t, {shortFirst: true, noCleanup: true});
  const row = f.events[0];
  const state = structuredClone(row.state);
  const r = state.attempts[0].resources.find(r => r.kind === 'short');
  const out = transitionEstimatedPace50State(state, {type: 'window_reset_settled', event_id: 'no-proof',
    attempt_id: 'late', at: r.resets_at + 100 * r.duration_ms, resource_ids: [r.id], authoritative_cessation: true});
  assert.equal(out.applied, false);
  assert.deepEqual(out.state, state);
});

test('the lender clears missing successor readings at the fixed cessation bound after restart', async t => {
  const f = await scene(t, {shortFirst: true, coverage: 'none'});
  const state = f.adapter.state();
  const short = state.attempts[0].resources.find(r => r.kind === 'short');
  assert.equal(state.attempts.length, 1);
  assert.equal(short.held_micro, short.initial_micro);
  await f.adapter.close(); Object.assign(f, f.open());
  f.clock.at = state.attempts[0].cleanup_proof_persisted_at + short.duration_ms - 1;
  await f.candidate.probeHeld();
  assert.equal(f.adapter.state().attempts[0].resources.find(r => r.id === short.id).held_micro, short.initial_micro);
  f.clock.at += 1;
  await f.candidate.probeHeld();
  const ended = f.adapter.state().attempts[0].resources.find(r => r.id === short.id);
  assert.deepEqual([ended.spent_micro, ended.held_micro, ended.unrepresented_micro, ended.released_micro], [ended.initial_micro, 0, 0, 0]);
  f.clock.at=Math.max(RESET,state.attempts[0].cleanup_proof_persisted_at+state.attempts[0].resources.find(r=>r.kind==='weekly').duration_ms);
  await f.candidate.probeHeld();
  assert.equal(f.adapter.state().attempts.length, 1);
  assert.equal(f.adapter.state().attempts[0].hold_closed, true);
});

test('late cessation acknowledgement records a durable fixed bound without cleanup or a live clock', async t => {
  const f = await scene(t, {shortFirst: true});
  const {state} = delayedShortEvent(f, 0);
  const owner = state.attempts[0];
  owner.late_ack_events = []; owner.late_ack_unresolved = false;
  owner.cleanup_proven = false; owner.cleanup_proof_persisted_at = null;
  const event = {type: 'cessation_proven', event_id: 'late-cessation-proof', attempt_id: owner.id,
    at: state.updated_at, authoritative_cessation: true, usage_reconciled: true};
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, true, out.reason);
  assert.equal(out.state.attempts[0].late_ack_events.at(-1).cessation_at, event.at);
  await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(out.state));
  Object.assign(f, f.open());
  const restored = f.adapter.state().attempts[0];
  const r = restored.resources.find(r => r.kind === 'short');
  assert.equal(policy.lateCarryBound(restored, r), BigInt(event.at + 5 * HOUR_MS));
  for (const [ceased, expected] of [[SHORT_RESET-RESET_JITTER_MS-1,SHORT_RESET-RESET_JITTER_MS-1+5*HOUR_MS],
    [SHORT_RESET - 1, SHORT_RESET - 1 + 5 * HOUR_MS], [SHORT_RESET, SHORT_RESET + 5 * HOUR_MS],
    [SHORT_RESET + 5 * HOUR_MS, SHORT_RESET + 10 * HOUR_MS], [SHORT_RESET + 5 * HOUR_MS + 1, SHORT_RESET + 10 * HOUR_MS + 1]]) {
    const attempt = {...restored, late_ack_events: [{at: NOW, cessation_at: ceased, resolved_by: null}]};
    assert.equal(policy.lateCarryBound(attempt, r), BigInt(expected));
  }
  f.mode.coverage = 'none';
  f.clock.at = Number(restored.resources.reduce((bound, r) => {
    const next = policy.lateCarryBound(restored, r); return next > bound ? next : bound;
  }, 0n));
  await f.candidate.probeHeld();
  assert.equal(f.adapter.state().attempts[0].hold_closed, true, 'durable cessation also drives the lender after restart');
});

for (const coverage of ['short', 'weekly']) test(`the lender carries only ${coverage} then bounds the missing resource`, async t => {
  const f = await scene(t, {shortFirst: true, bothReset: true, coverage});
  const state = f.adapter.state();
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[1].resources[0].kind, coverage);
  const missing = state.attempts[0].resources.find(r => r.kind !== coverage);
  assert.equal(missing.held_micro, missing.initial_micro);
  f.mode.coverage = 'none';
  await f.adapter.close(); Object.assign(f, f.open());
  f.clock.at = Math.max(...state.attempts[0].resources.map(r => state.attempts[0].cleanup_proof_persisted_at + r.duration_ms));
  await f.candidate.probeHeld();
  const ended = f.adapter.state();
  assert.equal(ended.attempts.length, 2);
  for (const a of ended.attempts) {
    assert.equal(a.hold_closed, true);
    assert.equal(a.late_ack_unresolved, false);
    for (const r of a.resources) assert.deepEqual([r.spent_micro, r.held_micro, r.unrepresented_micro, r.released_micro], [r.initial_micro, 0, 0, 0]);
  }
});

test('an unseen off-grid successor stays fenced through restart until cessation plus one duration', async t => {
  const firstUseGap = 4.5 * HOUR_MS;
  const f = await scene(t, {shortFirst: true, coverage: 'none', firstUseGap, offGridShort: true});
  const state = f.adapter.state(), owner = state.attempts[0];
  const short = owner.resources.find(r => r.kind === 'short');
  const ceased = owner.cleanup_proof_persisted_at;
  assert.equal(ceased, SHORT_RESET + firstUseGap + 1000);
  assert.equal(state.attempts.length, 1, 'no successor reading reached the lender');
  f.mode.coverage = 'all';
  const hidden = await f.source.observe({provider: 'claude', now: ceased});
  f.mode.coverage = 'none';
  assert.equal(hidden.resources.find(r => r.kind === 'short').anchor_at, SHORT_RESET + firstUseGap);
  assert.notEqual(firstUseGap % short.duration_ms, 0);
  await f.adapter.close(); Object.assign(f, f.open());
  for (const at of [SHORT_RESET + short.duration_ms, ceased + short.duration_ms - 1]) {
    f.clock.at = at; await f.candidate.probeHeld();
    const held = f.adapter.state().attempts[0].resources.find(r => r.id === short.id);
    assert.deepEqual([held.held_micro, held.spent_micro, held.unrepresented_micro, held.released_micro], [short.initial_micro, 0, 0, 0]);
    assert.equal(f.adapter.state().attempts.length, 1);
  }
  f.clock.at = ceased + short.duration_ms;
  await f.candidate.probeHeld();
  const spent = f.adapter.state().attempts[0].resources.find(r => r.id === short.id);
  assert.deepEqual([spent.held_micro, spent.spent_micro, spent.unrepresented_micro, spent.released_micro], [0, short.initial_micro, 0, 0]);
  assert.equal(f.adapter.state().attempts.length, 1);
});

test('a short-only carry without weekly mapping cannot advance any account week', async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 0);
  const owner = state.attempts[0];
  event.account_week_id = 'unproven-new-week'; event.epoch = 'unproven-new-epoch';
  event.identity_verified = event.complete = event.refresh_succeeded = true;
  event.account = owner.account;
  for (const c of event.carries) c.resource.epoch = event.epoch;
  delete event.weekly_mapping;
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, true, out.reason);
  assert.equal(out.state.attempts.at(-1).account_week_id, owner.account_week_id);
  assert.equal(out.state.attempts[0].account_week_id, owner.account_week_id);
  assert.equal(out.state.account_week_id, state.account_week_id);
  assert.deepEqual(out.state.provider_weeks, state.provider_weeks);
  assert.deepEqual(out.state.opening_tokens, state.opening_tokens);
});

for (const offset of [-30000, -10000, 0, -RESET_JITTER_MS, -RESET_JITTER_MS - 1]) {
  test(`unseen jitter successor with cessation offset ${offset} stays fenced through restart`, async t => {
    const f = await scene(t, {shortFirst: true});
    const {state} = delayedShortEvent(f, 0);
    const owner = state.attempts[0], r = owner.resources.find(r => r.kind === 'short');
    const ceased = r.resets_at + offset;
    owner.cleanup_proof_persisted_at = state.updated_at = ceased;
    for (const late of owner.late_ack_events) late.at = Math.min(late.at, ceased);
    f.mode.coverage = 'none';
    await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(state));
    Object.assign(f, f.open());
    const bound=Math.max(r.resets_at,ceased+r.duration_ms);
    for (const at of [...new Set([r.resets_at, bound - 1])].filter(at => at < bound)) {
      f.clock.at = at; await f.candidate.probeHeld();
      const pending = f.adapter.state().attempts[0].resources.find(x => x.id === r.id);
      assert.deepEqual([pending.held_micro, pending.spent_micro, pending.released_micro], [r.initial_micro, 0, 0]);
      assert.equal(f.adapter.state().attempts.length, 1);
    }
    f.clock.at = bound; await f.candidate.probeHeld();
    const spent = f.adapter.state().attempts[0].resources.find(x => x.id === r.id);
    assert.deepEqual([spent.held_micro, spent.spent_micro, spent.unrepresented_micro, spent.released_micro], [0, r.initial_micro, 0, 0]);
    assert.equal(f.adapter.state().attempts.length, 1);
  });
}

for (const timestamp of [null, undefined]) test(`fresh verified cleanup repairs legacy timestamp ${timestamp}`, async t => {
  const f = await scene(t, {shortFirst: true, coverage: 'none'});
  const state = f.adapter.state(), owner = state.attempts[0];
  if (timestamp === undefined) delete owner.cleanup_proof_persisted_at;
  else owner.cleanup_proof_persisted_at = null;
  assert.equal(owner.cleanup_proven, true);
  f.mode.coverage = 'none';
  await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(state));
  Object.assign(f, f.open());
  f.clock.at = RESET + WEEK_MS;
  await f.candidate.probeHeld();
  assert.deepEqual(f.adapter.state(), state, 'a sweep cannot invent the missing proof time');
  assert.equal((await f.candidate.recordCleanup('late', {removed: false})).reason, 'cleanup_unverified');
  assert.deepEqual(f.adapter.state(), state);
  const verifiedAt = f.clock.at;
  const proof = await f.candidate.recordCleanup('late', {removed: true});
  assert.equal(proof.applied, true, proof.reason);
  const repaired = f.adapter.state();
  assert.equal(repaired.attempts[0].cleanup_proof_persisted_at, verifiedAt);
  await f.adapter.close(); Object.assign(f, f.open());
  assert.deepEqual(f.adapter.state(), repaired);
  f.clock.at = verifiedAt + WEEK_MS - 1;
  await f.candidate.probeHeld();
  assert.ok(f.adapter.state().attempts[0].resources.find(r => r.kind === 'weekly').held_micro > 0);
  f.clock.at += 1; await f.candidate.probeHeld();
  const ended = f.adapter.state().attempts[0];
  assert.equal(ended.hold_closed, true);
  assert.ok(ended.resources.every(r => r.held_micro === 0 && r.unrepresented_micro === 0 && r.spent_micro === r.initial_micro));
});

for (const [name, change] of [
  ['absent resource and reset', e => {delete e.weekly_resource_id; delete e.weekly_resets_at;}],
  ['absent account', e => {delete e.account;}],
  ['absent provider account', e => {delete e.weekly_account_id;}],
  ['foreign provider account', e => {e.weekly_account_id = 'foreign-provider';}],
  ['foreign account', e => {e.account = 'foreign';}],
  ['absent resource', e => {delete e.weekly_resource_id;}],
  ['absent reset', e => {delete e.weekly_resets_at;}],
  ['wrong derived label', e => {e.account_week_id = 'unbound-week';}],
]) test(`week advancement with ${name} refuses unchanged`, () => {
  const state = policy.createEstimatedPace50State({account: ACCOUNT, account_week_id: WEEK});
  const reset = NOW + WEEK_MS;
  const event = {type: 'advance_account_week', event_id: 'advance-mapping', at: NOW,
    account: ACCOUNT, weekly_account_id: ACCOUNT, account_week_id: `${ACCOUNT}:weekly:${reset}`, account_week_mapping_known: true,
    weekly_resource_id: 'seven_day', weekly_resets_at: reset};
  change(event);
  const out = transitionEstimatedPace50State(state, event);
  assert.equal(out.applied, false);
  assert.equal(out.reason, 'account_week_identity');
  assert.deepEqual(out.state, state);
});

for (const covered of [false, true]) test(`cleanup after an unflagged reset establishes late exposure (covered=${covered})`, async t => {
  const f = await scene(t, {shortFirst: true});
  const {state, event} = delayedShortEvent(f, 0);
  const owner = state.attempts[0];
  owner.late_ack_events = []; owner.late_ack_unresolved = false;
  owner.cleanup_proven = false; owner.cleanup_proof_persisted_at = null;
  owner.process_state = 'running'; owner.cessation_proven = false;
  const proof = {type: 'cleanup_proven', event_id: 'late:cleanup-proven:overdue', attempt_id: 'late', at: event.at, cleanup_removed: true};
  const out = transitionEstimatedPace50State(state, proof);
  assert.equal(out.applied, true, out.reason);
  const cleaned = out.state.attempts[0];
  assert.equal(cleaned.late_ack_unresolved, true);
  assert.equal(cleaned.late_ack_events.at(-1).cessation_at, proof.at);
  assert.equal(cleaned.cleanup_proven, true);
  assert.equal(cleaned.cleanup_proof_persisted_at, proof.at);
  assert.equal(cleaned.cessation_proven, false);
  f.mode.coverage = covered ? 'all' : 'none';
  await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(out.state));
  Object.assign(f, f.open()); f.clock.at = proof.at;
  await f.candidate.probeHeld();
  const short = cleaned.resources.find(r => r.kind === 'short');
  if (covered) {
    const carry = f.adapter.state().attempts.find(a => a.id === `late:carry:${short.id}:${short.instance}`);
    assert.ok(carry, 'the successor receives the maximum after restart');
    assert.equal(carry.resources[0].unrepresented_micro, short.initial_micro);
  } else {
    assert.equal(f.adapter.state().attempts.length, 1);
    assert.equal(f.adapter.state().attempts[0].resources.find(r => r.id === short.id).held_micro, short.initial_micro);
    f.clock.at = proof.at + short.duration_ms - 1; await f.candidate.probeHeld();
    assert.equal(f.adapter.state().attempts[0].resources.find(r => r.id === short.id).held_micro, short.initial_micro);
    f.clock.at += 1; await f.candidate.probeHeld();
    assert.equal(f.adapter.state().attempts[0].resources.find(r => r.id === short.id).held_micro, 0);
  }
});

test('cleanup before every reset leaves the late-exposure flag clear', async t => {
  const f = await scene(t, {shortFirst: true});
  const {state} = delayedShortEvent(f, 0);
  const owner = state.attempts[0];
  owner.late_ack_events = []; owner.late_ack_unresolved = false;
  owner.cleanup_proven = false; owner.cleanup_proof_persisted_at = null;
  owner.process_state = 'running'; owner.cessation_proven = false;
  const at = Math.min(...owner.resources.map(r => r.resets_at)) - RESET_JITTER_MS - 1;
  state.updated_at = at;
  const out = transitionEstimatedPace50State(state, {type: 'cleanup_proven', event_id: 'late:cleanup-proven:on-time',
    attempt_id: 'late', at, cleanup_removed: true});
  assert.equal(out.applied, true, out.reason);
  assert.equal(out.state.attempts[0].late_ack_unresolved, false);
  assert.deepEqual(out.state.attempts[0].late_ack_events, []);
  assert.equal(out.state.attempts[0].cleanup_proven, true);
});

for (const offset of [-RESET_JITTER_MS, -1, 0, -RESET_JITTER_MS - 1]) test(`unflagged cleanup at offset ${offset} uses the durable overlap fence after restart`, async t => {
  const f = await scene(t, {shortFirst: true});
  const {state} = delayedShortEvent(f, 0), owner = state.attempts[0];
  owner.late_ack_events = []; owner.late_ack_unresolved = false;
  owner.cleanup_proven = false; owner.cleanup_proof_persisted_at = null;
  owner.process_state = 'running'; owner.cessation_proven = false;
  const r = owner.resources.find(r => r.kind === 'short'), ceased = r.resets_at + offset;
  state.updated_at = ceased;
  const out = transitionEstimatedPace50State(state, {type: 'cleanup_proven', event_id: 'late:cleanup-proven:edge',
    attempt_id: owner.id, at: ceased, cleanup_removed: true});
  assert.equal(out.applied, true, out.reason);
  const exposed = offset >= -RESET_JITTER_MS;
  assert.equal(out.state.attempts[0].late_ack_unresolved, exposed);
  f.mode.coverage = 'none';
  await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(out.state));
  Object.assign(f, f.open()); f.clock.at = r.resets_at;
  await f.candidate.probeHeld();
  const restored = () => f.adapter.state().attempts[0].resources.find(x => x.id === r.id);
  assert.equal(restored().held_micro, exposed ? r.initial_micro : 0);
  if (exposed) {
    f.clock.at = ceased + r.duration_ms - 1; await f.candidate.probeHeld();
    assert.equal(restored().held_micro, r.initial_micro);
    f.clock.at += 1; await f.candidate.probeHeld();
    assert.deepEqual([restored().held_micro, restored().unrepresented_micro, restored().spent_micro], [0, 0, r.initial_micro]);
  }
});

for (const bothReset of [false, true]) test(`raw old-build cleanup state stays fenced without a late flag after upgrade (bothReset=${bothReset})`, async t => {
  const f = await scene(t, {shortFirst: true});
  // Literal old-writer data: no current cleanup or cessation reducer constructs this snapshot.
  const ceased = SHORT_RESET + 1000;
  const short = {id: 'five_hour', instance: 'legacy-short', epoch: 'legacy-epoch', kind: 'short',
    anchor_at: SHORT_RESET - 5 * HOUR_MS, resets_at: SHORT_RESET, duration_ms: 5 * HOUR_MS,
    conversion: 'native_window', kappa_micro: null, baseline_used_micro: 0,
    aggregate_observed_at: NOW, aggregate_used_micro: 0, initial_micro: 1000000, spent_micro: 0,
    settled_micro: 0, held_micro: 1000000, released_micro: 0, unrepresented_micro: 0, burns: []};
  const state = {version: 'objective-lending/state/4', account: ACCOUNT, account_week_id: WEEK,
    revision: 1, mode: 'on', owner_present: false, owner_absent_since: null, updated_at: ceased,
    event_ids: ['late:cleanup-proven:legacy'], opened_windows: [], opening_tokens: [{account_week_id: WEEK, status: 'unused', attempt_id: null}],
    attempts: [{id: 'late', account: ACCOUNT, account_week_id: WEEK, epoch: 'legacy-epoch', job_id: 'legacy-job',
      created_at: NOW, wall_ms: 300000, stop_ms: 60000, uncertainty_ms: 0, launch_state: 'started',
      process_state: 'ceased', cessation_proven: true, hold_closed: false, cleanup_proven: true,
      cleanup_proof_persisted_at: ceased, late_ack_unresolved: false, late_ack_events: [],
      opening: null, recoveries: [], usage_unknown: null, resources: [short]}]};
  if (bothReset) state.attempts[0].resources.push({...short, id: 'seven_day', instance: 'legacy-week', kind: 'weekly',
    anchor_at: SHORT_RESET - WEEK_MS, duration_ms: WEEK_MS, burns: []});
  f.mode.coverage = 'none';
  await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(state));
  Object.assign(f, f.open());
  assert.deepEqual(f.adapter.state(), state, 'upgrade loads the raw state without migration');
  for (const at of [ceased, ceased + short.duration_ms - 1]) {
    f.clock.at = at; await f.candidate.probeHeld();
    assert.equal(f.adapter.state().attempts[0].resources.find(r => r.id === short.id).held_micro, short.initial_micro);
  }
  f.clock.at = ceased + short.duration_ms; await f.candidate.probeHeld();
  const r = f.adapter.state().attempts[0].resources.find(r => r.id === short.id);
  assert.deepEqual([r.held_micro, r.unrepresented_micro, r.spent_micro], [0, 0, r.initial_micro]);
  if (bothReset) assert.ok(f.adapter.state().attempts[0].resources.find(r => r.kind === 'weekly').held_micro > 0);
});

for (const offset of [-RESET_JITTER_MS, -1, 0]) test(`direct cessation at offset ${offset} preserves successor exposure`, async t => {
  const f = await scene(t, {shortFirst: true});
  const {state} = delayedShortEvent(f, 0), owner = state.attempts[0];
  owner.late_ack_events = []; owner.late_ack_unresolved = false;
  owner.cleanup_proven = false; owner.cleanup_proof_persisted_at = null;
  owner.process_state = 'running'; owner.cessation_proven = false;
  const r = owner.resources.find(r => r.kind === 'short'), at = r.resets_at + offset;
  state.updated_at = at;
  const out = transitionEstimatedPace50State(state, {type: 'cessation_proven', event_id: 'direct-edge',
    attempt_id: owner.id, at, authoritative_cessation: true});
  // A borrower zero-use report is not evidence for a started attempt (usage_uncovered), so the physical cessation event carries none.
  assert.equal(out.applied, true, out.reason);
  assert.equal(out.state.attempts[0].late_ack_unresolved, true);
  assert.equal(out.state.attempts[0].late_ack_events.at(-1).cessation_at, at);
  assert.equal(out.state.attempts[0].resources.find(x => x.id === r.id).held_micro, r.initial_micro);
});

test('reserved launch state proves no absence of execution', () => {
  const resource = {resets_at: NOW, duration_ms: 5 * HOUR_MS};
  const attempt = {launch_state: 'reserved', late_ack_events: [], cleanup_proven: true, cleanup_proof_persisted_at: NOW};
  assert.equal(policy.executionProvenAbsent(attempt), false);
  assert.equal(policy.mayHaveSpentPast(attempt, resource), true);
});

test('a weekly late cessation without cleanup carries through the real held-work sweep and restart', async t => {
  const f = await scene(t, {weeklyFirst: true});
  const state = structuredClone(f.events[0].state), owner = state.attempts[0];
  owner.resources = owner.resources.filter(r => r.kind === 'weekly');
  owner.late_ack_events = []; owner.late_ack_unresolved = false;
  owner.cleanup_proven = false; owner.cleanup_proof_persisted_at = null;
  owner.process_state = 'running'; owner.cessation_proven = false;
  const weekly = owner.resources[0], ceased = weekly.resets_at + 1000;
  state.updated_at = ceased;
  await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(state));
  Object.assign(f, f.open()); f.clock.at = ceased;
  const proof = await f.adapter.transition({type: 'cessation_proven', event_id: 'weekly-authoritative-cessation',
    attempt_id: owner.id, at: ceased, authoritative_cessation: true, usage_reconciled: true}, {expectedRevision: state.revision});
  assert.equal(proof.applied, true, proof.reason);
  const before = f.adapter.state();
  assert.equal(before.attempts[0].late_ack_events.at(-1).cessation_at, ceased);
  assert.equal(before.attempts[0].cleanup_proven, false);
  assert.equal(before.attempts[0].cleanup_proof_persisted_at, null);
  await f.candidate.probeHeld();
  const carried = f.adapter.state();
  const successor = carried.attempts.find(a => a.id === `${owner.id}:carry:${weekly.id}:${weekly.instance}`);
  assert.ok(successor, 'a fresh successor reading must carry the weekly maximum with authoritative cessation alone');
  assert.equal(successor.resources[0].unrepresented_micro, weekly.initial_micro);
  assert.equal(carried.attempts[0].cleanup_proven, false, 'cessation does not claim sandbox removal');
  assert.equal(carried.attempts[0].cleanup_proof_persisted_at, null);
  await f.adapter.close(); Object.assign(f, f.open());
  assert.deepEqual(f.adapter.state(), carried, 'the carry and the distinction between proofs survive restart');
});

for (const usageReconciled of [true, false, undefined]) test(`an already-late attempt records cessation without readings (usage reconciled=${usageReconciled})`, async t => {
  const f = await scene(t, {shortFirst: true, noCleanup: true, coverage: 'none'});
  const before = f.adapter.state(), owner = before.attempts[0];
  assert.equal(owner.late_ack_unresolved, true);
  assert.ok(owner.late_ack_events.every(late => late.cessation_at === undefined));
  assert.equal(policy.lateCarryBound(owner, owner.resources[0]), null);
  f.clock.at += 1000;
  const ceased = f.clock.at;
  if (usageReconciled === true) {
    // A claim of reconciled usage needs fresh complete readings; without them the event is refused and nothing changes.
    const refused = await f.adapter.transition({type: 'cessation_proven', event_id: 'already-late-cessation-proof',
      attempt_id: owner.id, at: ceased, authoritative_cessation: true, usage_reconciled: true}, {expectedRevision: before.revision});
    assert.equal(refused.applied, false);
    assert.equal(refused.reason, 'late_ack_reconciliation_incomplete');
    assert.deepEqual(f.adapter.state(), before);
    return;
  }
  const proof = await f.adapter.transition({type: 'cessation_proven', event_id: 'already-late-cessation-proof',
    attempt_id: owner.id, at: ceased, authoritative_cessation: true,
    ...(usageReconciled === undefined ? {} : {usage_reconciled: usageReconciled})}, {expectedRevision: before.revision});
  assert.equal(proof.applied, true, proof.reason);
  const saved = f.adapter.state(), proven = saved.attempts[0];
  assert.ok(proven.late_ack_events.filter(late => late.resolved_by === null).every(late => late.cessation_at === ceased));
  assert.deepEqual(proven.resources, owner.resources, 'cessation alone reconciles or releases no usage');
  assert.equal(proven.late_ack_unresolved, true);
  assert.equal(proven.cleanup_proven, false);
  assert.equal(proven.cleanup_proof_persisted_at, null);
  await f.adapter.close(); Object.assign(f, f.open());
  assert.deepEqual(f.adapter.state(), saved);
  const short = owner.resources.find(r => r.kind === 'short');
  f.clock.at = ceased + short.duration_ms - 1; await f.candidate.probeHeld();
  assert.equal(f.adapter.state().attempts[0].resources.find(r => r.id === short.id).held_micro, short.initial_micro);
  f.clock.at += 1; await f.candidate.probeHeld();
  assert.equal(f.adapter.state().attempts[0].resources.find(r => r.id === short.id).held_micro, 0);
  const week=owner.resources.find(r=>r.kind==='weekly');
  f.clock.at=Math.max(week.resets_at,ceased+week.duration_ms);
  await f.candidate.probeHeld();
  const ended = f.adapter.state().attempts[0];
  assert.equal(ended.hold_closed, true);
  assert.equal(ended.late_ack_unresolved, false);
  assert.ok(ended.resources.every(r => r.held_micro === 0 && r.unrepresented_micro === 0 && r.spent_micro === r.initial_micro));
});

async function stoppedWeekly(t, {fullBurn = false, represented = true, legacy = false} = {}) {
  const f = await scene(t, {weeklyFirst: true});
  const state = structuredClone(f.events[0].state), owner = state.attempts[0];
  owner.resources = owner.resources.filter(r => r.kind === 'weekly');
  owner.late_ack_events = []; owner.late_ack_unresolved = false;
  owner.cleanup_proven = false; owner.cleanup_proof_persisted_at = null;
  owner.process_state = 'running'; owner.cessation_proven = false;
  const r = owner.resources[0], charge = fullBurn ? r.initial_micro : 1000000;
  const ceased = r.resets_at + 1;
  r.spent_micro = charge; r.held_micro = r.initial_micro - charge;
  r.unrepresented_micro = represented ? 0 : charge;
  r.burns = [{id: 'old-scope-burn', amount_micro: charge, at: r.resets_at - 1, represented}];
  state.updated_at = r.resets_at - 1;
  if (legacy) {
    owner.cleanup_proven = true; owner.cleanup_proof_persisted_at = ceased;
    owner.process_state = 'ceased'; owner.cessation_proven = true; owner.hold_closed = false;
    state.updated_at = ceased; state.event_ids.push('late:cleanup-proven:legacy'); state.revision++;
  }
  await f.adapter.close(); fs.writeFileSync(join(f.directory, 'lending-pace50-state.json'), JSON.stringify(state));
  Object.assign(f, f.open()); f.clock.at = ceased;
  if (!legacy) assert.equal((await f.candidate.recordCleanup(owner.id, {removed: true})).applied, true);
  return {f, ceased, resource: r, charge};
}

test('repeated late cessation cannot release on an old-window reading and the held-work sweep closes at the bound', async t => {
  const {f, ceased, resource: r, charge} = await stoppedWeekly(t);
  f.mode.coverage = 'none';
  for (const seq of [1, 2]) {
    const before = f.adapter.state(); f.clock.at = ceased + seq;
    await f.adapter.transition({type: 'cessation_proven', event_id: `repeat-cessation:${seq}`, attempt_id: 'late',
      at: f.clock.at, authoritative_cessation: true, usage_reconciled: true, complete: true, compatible: true,
      refresh_succeeded: true, observed_at: r.resets_at - 1,
      resources: [{id: r.id, instance: r.instance, anchor_at: r.anchor_at, resets_at: r.resets_at,
        used_micro: r.baseline_used_micro + charge}]}, {expectedRevision: before.revision});
    const after = f.adapter.state().attempts[0];
    assert.deepEqual(after.resources, before.attempts[0].resources, 'old-scope coverage cannot release successor exposure');
    assert.equal(after.late_ack_unresolved, true);
    await f.candidate.probeHeld();
  }
  const saved = f.adapter.state(); await f.adapter.close(); Object.assign(f, f.open());
  assert.deepEqual(f.adapter.state(), saved);
  f.clock.at = ceased + r.duration_ms - 1; await f.candidate.probeHeld();
  assert.equal(f.adapter.state().attempts[0].resources[0].released_micro, 0);
  f.clock.at += 1; await f.candidate.probeHeld();
  const ended = f.adapter.state().attempts[0];
  assert.equal(ended.hold_closed, true);
  assert.deepEqual([ended.resources[0].held_micro, ended.resources[0].unrepresented_micro, ended.resources[0].spent_micro,
    ended.resources[0].released_micro], [0, 0, r.initial_micro, 0]);
});

for (const fullBurn of [false, true]) test(`old-scope burn coverage retains an owed and reachable late exposure (fully spent=${fullBurn})`, async t => {
  const {f, ceased, resource: r, charge} = await stoppedWeekly(t, {fullBurn, represented: false});
  const before = f.adapter.state(); f.clock.at = ceased + 1;
  const out = await f.adapter.transition({type: 'reconcile_burn', event_id: 'old-burn-covered', attempt_id: 'late',
    at: f.clock.at, observed_at: r.resets_at - 1, account: before.account, epoch: before.attempts[0].epoch,
    burn_id: 'old-scope-burn', complete: true, compatible: true, refresh_succeeded: true, attribution_confirmed: true,
    resources: [{id: r.id, instance: r.instance, anchor_at: r.anchor_at, resets_at: r.resets_at,
      used_micro: r.baseline_used_micro + charge}]}, {expectedRevision: before.revision});
  // Production has no measured posting-lag bound, so a covering reading never clears a burn or releases a hold.
  assert.equal(out.applied, false, 'without a measured bound coverage clears nothing');
  assert.equal(out.reason, 'usage_coverage_unavailable');
  assert.deepEqual(f.adapter.state(), before);
  assert.equal(f.adapter.state().attempts[0].resources[0].unrepresented_micro, before.attempts[0].resources[0].unrepresented_micro);
  f.mode.coverage = 'none'; f.clock.at = ceased + r.duration_ms; await f.candidate.probeHeld();
  assert.equal(f.adapter.state().attempts[0].hold_closed, true, 'only the durable deadline closes it');
});

test('legacy late cleanup with no flag reaches a successor carry through effective lateness', async t => {
  const {f, resource: r} = await stoppedWeekly(t, {legacy: true});
  assert.equal(f.adapter.state().attempts[0].late_ack_unresolved, false);
  await f.candidate.probeHeld();
  assert.equal(f.adapter.state().attempts.length, 2);
  assert.equal(f.adapter.state().attempts[1].resources[0].unrepresented_micro, r.initial_micro);
});
