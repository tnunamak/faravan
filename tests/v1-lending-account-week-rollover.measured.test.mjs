import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {settleAdapterAtBound} from './helpers/lending-settle-at-bound.mjs';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {ACCOUNT, DAY_MS, HOUR_MS, MICRO, NOW, WEEK} from './helpers/pace50-fixtures.mjs';
import {OWNER_NONE, calibration, job} from './helpers/lending-objective-fixtures.mjs';

const ROLLOVER = NOW + HOUR_MS + 60_000;
const OLD_SHORT_RESET = ROLLOVER + 3 * HOUR_MS;
const NEW_WEEK_RESET = ROLLOVER + 7 * DAY_MS;
const WEEK2 = `${ACCOUNT}:weekly:${NEW_WEEK_RESET}`;
const OLD_ATTEMPT = 'held-from-week-1';

function resource({id, kind, instance, epoch, now, resetAt, usedMicro}) {
  const duration = kind === 'weekly' ? 7 * DAY_MS : 5 * HOUR_MS;
  return {id, kind, instance, epoch, account: ACCOUNT, state: 'open', origin: kind === 'short' ? 'owner' : undefined,
    anchor_at: resetAt - duration, resets_at: resetAt, duration_ms: duration, observed_at: now,
    used_micro: usedMicro, kappa_micro: MICRO};
}

function bandFor(weekStart) {
  const band = calibration();
  return {...band, weekStart, weeks: band.weeks.map((week, i) => ({...week,
    end: weekStart - (19 - i) * 7 * DAY_MS}))};
}

function request(attemptId) {
  return {attempt_id: attemptId, job_id: `job-${attemptId}`, wall_ms: 300_000, stop_ms: 60_000,
    uncertainty_ms: 30_000, expires_at: NOW + 7 * DAY_MS, resumable: true};
}

test('account-week rollover keeps old held exposure durable and reconcilable after restart', async (t) => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'week-rollover-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const clock = {at: NOW};
  const handlers = {
    arm_cessation_deadline: async () => () => {},
    launch_chunk: async () => {},
    open_short_window: async () => {},
    cancel_pending_attempt: async () => {},
    request_cessation: async () => {},
    request_fresh_complete_reconciliation: async () => {},
  };
  const buildInput = async ({now}) => {
    const isWeek2 = now >= ROLLOVER;
    const epoch = isWeek2 ? 'epoch-2' : 'epoch-1';
    const weekReset = isWeek2 ? NEW_WEEK_RESET : NOW + HOUR_MS;
    const weekStart = weekReset - 7 * DAY_MS;
    const shortReset = isWeek2 ? ROLLOVER + 5 * HOUR_MS : OLD_SHORT_RESET;
    const windows = [
      resource({id: 'seven_day', kind: 'weekly', instance: `weekly-${epoch}`, epoch, now,
        resetAt: weekReset, usedMicro: 10 * MICRO}),
      resource({id: 'five_hour', kind: 'short', instance: `short-${epoch}`, epoch, now,
        resetAt: shortReset, usedMicro: 0}),
    ];
    return {
      now, account: ACCOUNT, account_week_id: isWeek2 ? WEEK2 : WEEK, epoch, weekly_resource_id: 'seven_day', windows,
      controls: {consent: true, people: true, agents: true, schedule: true, unexpired: true, on: true,
        paused: false, owner_absent: true},
      evidence: {complete: true, refresh_succeeded: true, subscription_only: true, bounded_execution: true,
        single_executor: true, identity_compatible: true, resource_ids: windows.map(row => row.id),
        account_week_mapping_known: true},
      objective: {position: 'balanced', band: bandFor(weekStart), owner: OWNER_NONE,
        laterBurnCapacityMicro: 0,
        job: job({friendValue: 3, requestedUsdMicro: 3 * MICRO, estimateUsdMicro: 3 * MICRO})},
    };
  };
  const open = () => createPace50Adapter({postingLagBoundMs:120000,directory, account: ACCOUNT, account_week_id: WEEK,
    buildInput, effects: handlers, now: () => clock.at});

  let adapter = open();
  const first = await adapter.admit({expectedRevision: 0, request: request(OLD_ATTEMPT)});
  assert.equal(first.admitted, true, `seed the old-week hold: ${first.reason}`);
  await adapter.transition({type: 'launch_result', event_id: `${OLD_ATTEMPT}:started`, at: NOW + 1,
    attempt_id: OLD_ATTEMPT, result: 'started'}, {expectedRevision: adapter.state().revision});
  await adapter.transition({type: 'usage_unknown', event_id: `${OLD_ATTEMPT}:usage-unknown`, at: NOW + 2,
    attempt_id: OLD_ATTEMPT, provider: 'claude'}, {expectedRevision: adapter.state().revision});
  const heldBefore = adapter.state().attempts[0].resources.map(row => row.held_micro);
  assert.ok(heldBefore.every(value => value > 0));
  assert.ok(heldBefore.some(value => value > MICRO), 'the durable validator must accept an objective hold larger than one point');
  const unverifiedAdvance = await adapter.transition({type: 'advance_account_week', event_id: 'unverified-week-change',
    at: NOW + 3, account_week_id: WEEK2, account_week_mapping_known: true},
  {expectedRevision: adapter.state().revision});
  assert.equal(unverifiedAdvance.applied, false);
  assert.equal(unverifiedAdvance.reason, 'account_week_identity');

  clock.at = ROLLOVER;
  const nextRequest = request('new-week-attempt');
  const preview = await adapter.preview({request: nextRequest});
  assert.equal(adapter.state().account_week_id, WEEK, 'preview projects but does not persist the week change');
  const admission = await adapter.admit({expectedRevision: adapter.state().revision, request: nextRequest});
  assert.equal(adapter.state().account_week_id, WEEK2,
    'admission persists the verified account-week change before refusing on the old hold');
  const blockedByOldHold = await adapter.admit({expectedRevision: adapter.state().revision,
    request: request('new-week-after-rollover')});
  assert.equal(blockedByOldHold.reason, 'cross_window_exposure_unreconciled');
  assert.equal(adapter.state().account_week_id, WEEK2);
  assert.deepEqual(adapter.state().attempts[0].resources.map(row => row.held_micro), heldBefore,
    'week rollover does not drop or resize the old reservation');

  await adapter.close();
  clock.at = OLD_SHORT_RESET + 1;
  adapter = open();
  await adapter.deliver({type:'cessation_proven',event_id:'old-week:verified-cessation',at:clock.at,attempt_id:OLD_ATTEMPT,authoritative_cessation:true});
  await settleAdapterAtBound(adapter,at=>{clock.at=at;});
  const settled = await adapter.transition({type: 'window_reset_settled', event_id: 'settle:old-week-at-reset',
    at: clock.at, attempt_id: OLD_ATTEMPT, resource_ids: ['seven_day', 'five_hour'], authoritative_cessation: true},
  {expectedRevision: adapter.state().revision});
  assert.equal(settled.applied, false, 'the already-closed hold cannot settle twice');
  const finalState = adapter.state();
  const oldAttempt = finalState.attempts.find(attempt => attempt.id === OLD_ATTEMPT);
  assert.equal(finalState.account_week_id, WEEK2, 'reconciliation does not roll the account week backward');
  assert.equal(oldAttempt.process_state, 'ceased');
  assert.ok(oldAttempt.resources.every(row => row.held_micro === 0));

  await adapter.close();
  assert.equal(preview.reason, 'cross_window_exposure_unreconciled',
    `preview must apply the verified new-week identity before evaluating old exposure (got ${preview.reason})`);
  assert.equal(admission.reason, 'cross_window_exposure_unreconciled',
    `admission must persist the rollover but retain the old hold (got ${admission.reason})`);
});

import {lendingStatus} from '../lib/v1/lending-status-copy.mjs';

const resetFor = provider => NOW + (provider === 'codex' ? 2 : 1) * HOUR_MS;
const week = provider => `${ACCOUNT}:weekly:${resetFor(provider)}`;
const switchRequest = id => ({attempt_id: id, job_id: `job-${id}`, wall_ms: 300_000,
  stop_ms: 60_000, uncertainty_ms: 30_000, expires_at: NOW + DAY_MS, resumable: true});
// Each provider has its own meters: Codex's weekly meter is never Claude's seven_day.
const METERS = {claude: {seven_day: 'seven_day', five_hour: 'five_hour'}, codex: {seven_day: 'codex:10080', five_hour: 'codex:300'}};
function build(provider, evidencePatch = {}) {
  const resetAt = resetFor(provider);
  const weekStart = resetAt - 7 * DAY_MS;
  const meter = METERS[provider], renamed = record => Object.fromEntries(Object.entries(record).map(([key, value]) =>
    [meter[key.split('@')[0]] + (key.includes('@') ? '@' + key.split('@')[1] : ''), value]));
  const base = calibration();
  const band = {...base, domain: base.domain.map(d => meter[d.split('@')[0]] + '@decision'),
    weeks: base.weeks.map(row => ({...row, upperScores: renamed(row.upperScores)})),
    forecasts: base.forecasts.map(row => ({...row, id: meter[row.id], domain: meter[row.id] + '@decision'}))};
  const owner = {scenarios: OWNER_NONE.scenarios.map(scenario => ({...scenario,
    attempts: scenario.attempts.map(attempt => ({...attempt, need: renamed(attempt.need)}))}))};
  const windows = [
    {id: meter.seven_day, kind: 'weekly', resets_at: resetAt, duration_ms: 7 * DAY_MS, used_micro: 10 * MICRO},
    {id: meter.five_hour, kind: 'short', resets_at: NOW + 4 * HOUR_MS, duration_ms: 5 * HOUR_MS,
      used_micro: 0, origin: 'owner'},
  ].map(row => ({...row, account: ACCOUNT, instance: `${provider}-${row.id}`,
    epoch: provider, state: 'open', anchor_at: row.resets_at - row.duration_ms,
    observed_at: NOW, kappa_micro: MICRO}));
  return {now: NOW, account: ACCOUNT, account_week_id: week(provider), epoch: provider,
    weekly_resource_id: meter.seven_day, windows,
    controls: {consent: true, people: true, agents: true, schedule: true, unexpired: true,
      on: true, paused: false, owner_absent: true},
    evidence: {complete: true, refresh_succeeded: true, subscription_only: true,
      bounded_execution: true, single_executor: true, identity_compatible: true,
      resource_ids: windows.map(row => row.id), account_week_mapping_known: true, ...evidencePatch},
    objective: {position: 'balanced', band: {...band, weekStart,
      weeks: band.weeks.map((row, i) => ({...row, end: weekStart - (19 - i) * 7 * DAY_MS}))},
      owner, laterBurnCapacityMicro: 0,
      job: job({friendValue: 3, requestedUsdMicro: 3 * MICRO, estimateUsdMicro: 3 * MICRO})}};
}
function harness(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'provider-week-switch-'));
  let input = build('codex');
  const actions = [];
  const adapter = createPace50Adapter({postingLagBoundMs:120000,directory, account: ACCOUNT, account_week_id: week('codex'),
    buildInput: async () => input, now: () => NOW,
    effects: {arm_cessation_deadline: async () => () => {},
      launch_chunk: async () => { actions.push('launch'); },
      open_short_window: async () => { actions.push('open'); },
      cancel_pending_attempt: async () => {}, request_cessation: async () => {},
      request_fresh_complete_reconciliation: async () => {}}});
  t.after(async () => { await adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  return {adapter, actions, set: value => { input = value; }};
}
async function admitAndSettle(adapter, id) {
  const result = await adapter.admit({expectedRevision: adapter.state().revision, request: switchRequest(id)});
  assert.equal(result.admitted, true, `${id}: ${result.reason}`);
  const settled = await adapter.transition({type: 'cessation_proven', event_id: `${id}:ceased`,
    at: NOW, attempt_id: id, authoritative_cessation: true, usage_reconciled: true,
    zero_use_attested: true}, {expectedRevision: adapter.state().revision});
  assert.equal(settled.applied, true, settled.reason);
}