import './helpers/no-browser.mjs';
import {coverStoppedFixture} from './helpers/lending-settle-at-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Adapter} from '../lib/v1/lending-pace50-adapter.mjs';
import {ACCOUNT, DAY_MS, HOUR_MS, MICRO, NOW} from './helpers/pace50-fixtures.mjs';
import {calibration, job} from './helpers/lending-objective-fixtures.mjs';

// One lender lends two providers. Each provider's weekly meter has its own week; the durable state must follow both.
const CLAUDE_W1 = `${ACCOUNT}:weekly:${NOW + 1 * DAY_MS}`;
const CLAUDE_W2 = `${ACCOUNT}:weekly:${NOW + 7 * DAY_MS}`;
const CODEX_W1 = `${ACCOUNT}:weekly:${NOW + 3 * DAY_MS}`;
const CODEX_W2 = `${ACCOUNT}:weekly:${NOW + 6 * DAY_MS}`;
const FIXTURE = new URL('./fixtures/pace50-state-two-provider-week-1031.json', import.meta.url);

function windowRow({id, kind, resetAt, durationMs, usedMicro, account, now, epoch}) {
  return {id, kind, account, instance: `${id}@${resetAt}`, epoch, state: 'open',
    anchor_at: resetAt - durationMs, resets_at: resetAt, duration_ms: durationMs, observed_at: now,
    used_micro: usedMicro, kappa_micro: MICRO, ...(kind === 'short' ? {origin: 'owner'} : {})};
}

// A complete, verified reading. `weeklyId` names the provider's weekly meter; `week` is the week the provider mapped it to.
function build({account = ACCOUNT, week, weeklyId, resetAt, now = NOW, usedMicro = 10 * MICRO}) {
  const epoch = `${weeklyId}@${resetAt}`;
  const windows = [windowRow({id: weeklyId, kind: 'weekly', resetAt, durationMs: 7 * DAY_MS, usedMicro, account, now, epoch})];
  if (weeklyId === 'seven_day') windows.push(windowRow({id: 'five_hour', kind: 'short', resetAt: now + 4 * HOUR_MS,
    durationMs: 5 * HOUR_MS, usedMicro: 0, account, now, epoch}));
  const weekStart = resetAt - 7 * DAY_MS, band = bandFor(windows.map(row => row.id));
  return {now, account, weekly_account_id: week.split(':weekly:')[0], account_week_id: week, epoch, weekly_resource_id: weeklyId, windows,
    controls: {consent: true, people: true, agents: true, schedule: true, unexpired: true,
      on: true, paused: false, owner_absent: true},
    evidence: {complete: true, refresh_succeeded: true, subscription_only: true,
      bounded_execution: true, single_executor: true, identity_compatible: true,
      resource_ids: windows.map(row => row.id), account_week_mapping_known: true},
    objective: {position: 'balanced', band: {...band, weekStart,
      weeks: band.weeks.map((row, i) => ({...row, end: weekStart - (19 - i) * 7 * DAY_MS}))},
    owner: {scenarios: [{probability: 1, attempts: [{need: Object.fromEntries(windows.map(row => [row.id, 0])),
      value: 0, atomic: false}]}]},
    laterBurnCapacityMicro: 0,
    job: job({friendValue: 3, requestedUsdMicro: 3 * MICRO, estimateUsdMicro: 3 * MICRO})}};
}
// The calibration fixture covers Claude's meters; rename its domain to the meters this reading has.
function bandFor(ids) {
  const band = calibration(), domain = ids.map(id => `${id}@decision`);
  return {...band, domain, weeks: band.weeks.map(row => ({...row, upperScores: Object.fromEntries(domain.map(d => [d, 0]))})),
    forecasts: ids.map(id => ({id, domain: `${id}@decision`, prediction: 0, scale: 1}))};
}
const claude = (week, patch = {}) => build({week, weeklyId: 'seven_day', resetAt: NOW + (week === CLAUDE_W1 ? 1 : 7) * DAY_MS, ...patch});
const codex = (week, patch = {}) => build({week, weeklyId: 'codex:10080', resetAt: NOW + (week === CODEX_W1 ? 3 : 6) * DAY_MS, ...patch});

const request = (id, now = NOW) => ({attempt_id: id, job_id: `job-${id}`, wall_ms: 300_000, stop_ms: 60_000,
  uncertainty_ms: 30_000, expires_at: now + DAY_MS, resumable: true});

function harness(t, {directory = fs.mkdtempSync(join(tmpdir(), 'provider-week-')), account = ACCOUNT, week = CLAUDE_W1,
  at = NOW} = {}) {
  let input = null;
  const launches = [];
  const adapter = createPace50Adapter({postingLagBoundMs:0,directory, account, account_week_id: week,
    buildInput: async () => input, now: () => at,
    effects: {arm_cessation_deadline: async () => () => {},
      launch_chunk: async ({effect}) => { launches.push(effect?.attempt_id ?? 'launch'); },
      open_short_window: async () => {},
      cancel_pending_attempt: async () => {}, request_cessation: async () => {},
      request_fresh_complete_reconciliation: async () => {}}});
  t.after(async () => { await adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  return {adapter,launches,set:value=>{input=value;for(const w of input.windows){
    const prior=adapter.state().attempts.flatMap(a=>a.resources).filter(r=>r.id===w.id&&r.instance===w.instance&&r.epoch===w.epoch&&r.anchor_at===w.anchor_at&&r.resets_at===w.resets_at);
    w.used_micro=Math.max(w.used_micro,...prior.map(r=>r.aggregate_used_micro));
  }}};
}

async function admit(h, input, id) {
  h.set(input);
  return h.adapter.admit({expectedRevision: h.adapter.state().revision, request: request(id, input.now)});
}
async function admitAndSettle(h, input, id) {
  const result = await admit(h, input, id);
  assert.equal(result.admitted, true, `${id}: ${result.reason}`);
  await h.adapter.deliver({type:'cleanup_proven',event_id:`${id}:cleanup-proven:vm`,at:input.now,attempt_id:id,cleanup_removed:true});
  const settled = await h.adapter.transition({type: 'cessation_proven', event_id: `${id}:ceased`,
    at: input.now, attempt_id: id, authoritative_cessation: true, usage_reconciled: true,
    zero_use_attested: true}, {expectedRevision: h.adapter.state().revision});
  assert.equal(settled.applied,true,settled.reason);
  await coverStoppedFixture(h.adapter,id,input.now);
}

test('sandpiper sequence: Claude resets, a Claude job runs, then Codex is still admitted', async t => {
  const h = harness(t);
  await admitAndSettle(h, claude(CLAUDE_W1), 'claude-week-1');
  await admitAndSettle(h, codex(CODEX_W1), 'codex-before-claude-reset');
  // Claude's week resets while Codex's week continues.
  await admitAndSettle(h, claude(CLAUDE_W2), 'claude-after-reset');
  const back = await admit(h, codex(CODEX_W1), 'codex-after-claude-reset');
  assert.equal(back.admitted, true, `Codex must be admitted on its unchanged week (got ${back.reason})`);
  assert.equal(h.adapter.state().account_week_id, CODEX_W1);
  assert.deepEqual(h.adapter.state().provider_weeks, {seven_day: {account_week_id: CLAUDE_W2, resets_at: NOW + 7 * DAY_MS},
    'codex:10080': {account_week_id: CODEX_W1, resets_at: NOW + 3 * DAY_MS}});
});

test('weeks can alternate between providers many times', async t => {
  const h = harness(t);
  for (let i = 0; i < 3; i += 1) {
    await admitAndSettle(h, claude(CLAUDE_W1), `claude-${i}`);
    await admitAndSettle(h, codex(CODEX_W1), `codex-${i}`);
  }
  assert.equal(h.adapter.state().attempts.length, 6);
});

test('a reading from an earlier week of the same provider is refused', async t => {
  const h = harness(t);
  await admitAndSettle(h, codex(CODEX_W1), 'codex-week-1');
  await admitAndSettle(h, codex(CODEX_W2), 'codex-week-2');
  await admitAndSettle(h, claude(CLAUDE_W1), 'claude-between');
  const before = h.adapter.state();
  const launched = h.launches.length;
  h.set(codex(CODEX_W1));
  const preview = await h.adapter.preview({request: request('stale-preview')});
  const stale = await admit(h, codex(CODEX_W1), 'stale-codex');
  for (const result of [preview, stale]) {
    assert.equal(result.admitted, false);
    assert.equal(result.reason, 'account_week_identity');
  }
  assert.equal(h.launches.length, launched, 'no provider action for a stale week');
  assert.deepEqual(h.adapter.state(), before, 'the refused week change is not persisted');
});

test('an earlier week of a meter is refused even when this lender never saw it', async t => {
  const h = harness(t);
  await admitAndSettle(h, codex(CODEX_W2), 'codex-week-2');
  await admitAndSettle(h, claude(CLAUDE_W1), 'claude');
  const before = h.adapter.state();
  const earlier = await admit(h, codex(`${ACCOUNT}:weekly:${NOW + 2 * DAY_MS}`, {resetAt: NOW + 2 * DAY_MS}), 'unseen-earlier');
  assert.equal(earlier.reason, 'account_week_identity');
  assert.deepEqual(h.adapter.state(), before);
});

test('a week whose reset has passed never becomes the current week', async t => {
  const h = harness(t);
  await admitAndSettle(h, claude(CLAUDE_W1), 'claude');
  const before = h.adapter.state();
  const expired = await admit(h, codex(CODEX_W1, {resetAt: NOW - HOUR_MS}), 'expired');
  assert.equal(expired.admitted, false);
  assert.deepEqual(h.adapter.state(), before);
});

test('migration: a meter week entered without a job still admits that week later', async t => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'provider-week-legacy-'));
  const file = join(directory, 'lending-pace50-state.json');
  {
    const h = harness(t, {directory: fs.mkdtempSync(join(tmpdir(), 'provider-week-seed-'))});
    await admitAndSettle(h, codex(CODEX_W1), 'codex-week-1');
    // Codex resets: the move to its new week persists, but this job is refused (lending is paused).
    const paused = codex(CODEX_W2);
    paused.controls = {...paused.controls, paused: true};
    assert.equal((await admit(h, paused, 'codex-week-2-paused')).admitted, false);
    assert.equal(h.adapter.state().account_week_id, CODEX_W2);
    await admitAndSettle(h, claude(CLAUDE_W1), 'claude');
    // Write the state as an older build would have: no provider_weeks.
    const legacy = h.adapter.state();
    delete legacy.provider_weeks;
    fs.writeFileSync(file, JSON.stringify(legacy));
  }
  const h = harness(t, {directory, week: CLAUDE_W1});
  const back = await admit(h, codex(CODEX_W2), 'codex-week-2');
  assert.equal(back.admitted, true, `the newer Codex week must be admitted (got ${back.reason})`);
  assert.equal(h.adapter.state().provider_weeks['codex:10080'].account_week_id, CODEX_W2);
});

test('a reading that maps one provider meter to the week another meter holds is refused', async t => {
  const h = harness(t);
  await admitAndSettle(h, claude(CLAUDE_W1), 'claude');
  await admitAndSettle(h, codex(CODEX_W1), 'codex');
  const crossed = await admit(h, claude(CODEX_W1), 'crossed');
  assert.equal(crossed.admitted, false);
  assert.equal(crossed.reason, 'account_week_identity');
  assert.equal(h.adapter.state().account_week_id, CODEX_W1);
});
