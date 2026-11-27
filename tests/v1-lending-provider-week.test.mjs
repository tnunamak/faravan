import './helpers/no-browser.mjs';
import {coverStoppedFixture} from './helpers/lending-settle-at-bound.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {settleOwnResets, assertAdmissionCounts, exposure} from './helpers/pace50-reset-assertions.mjs';
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
  const scopes=new Map(),weeks=new Map(),owned=new Set();
  const launches = [];
  const adapter = createPace50Adapter({postingLagBoundMs:0,directory, account, account_week_id: week,
    buildInput: async () => input, now: () => at,
    effects: {arm_cessation_deadline: async () => () => {},
      launch_chunk: async ({effect}) => { launches.push(effect?.attempt_id ?? 'launch'); },
      open_short_window: async () => {},
      cancel_pending_attempt: async () => {}, request_cessation: async () => {},
      request_fresh_complete_reconciliation: async () => {}}});
  t.after(async () => {
    try {
      for(const a of adapter.state().attempts.filter(a=>owned.has(a.id)&&a.hold_closed!==true)) await settleOwnResets(adapter,a.id);
    } finally { await adapter.close(); fs.rmSync(directory, {recursive: true, force: true}); }
  });
  return {adapter, launches, scopes, weeks, owned, set: value => { input = {...value,now:at,windows:value.windows.map(w=>({...w,observed_at:at}))}; },
    get at(){return at;}, advance: value=>{at=value;} };
}

async function admit(h, input, id) {
  const known=h.scopes.get(`${input.weekly_resource_id}:${input.account_week_id}`);
  h.set(known?{...input,windows:known,account_week_id:h.weeks.get(`${input.weekly_resource_id}:${input.account_week_id}`)??input.account_week_id}:input);
  return h.adapter.admit({expectedRevision: h.adapter.state().revision, request: request(id, h.at)});
}
async function admitAndFinishHeld(h, input, id) {
  const providerIds=new Set(input.windows.map(w=>w.id));
  const old=h.adapter.state().attempts.filter(a=>a.hold_closed!==true&&a.resources.some(r=>providerIds.has(r.id)&&r.epoch!==input.epoch));
  for(const a of old) await settleOwnResets(h.adapter,a.id);
  h.advance(Math.max(h.at,h.adapter.state().updated_at??h.at));
  const key=`${input.weekly_resource_id}:${input.account_week_id}`;
  if(!h.scopes.has(key)) {
    const shift=Math.max(0,h.at+DAY_MS-input.windows.find(w=>w.kind==='weekly').resets_at);
    h.scopes.set(key,input.windows.map(w=>({...w,anchor_at:w.kind==='short'?h.at-HOUR_MS:w.anchor_at+shift,resets_at:w.kind==='short'?h.at+4*HOUR_MS:w.resets_at+shift})));
    // A week's identity names its reset, so a week moved to a later reset takes the identity of that reset.
    if(shift>0)h.weeks.set(key,`${ACCOUNT}:weekly:${h.scopes.get(key).find(w=>w.kind==='weekly').resets_at}`);
  }
  input={...input,windows:h.scopes.get(key),now:h.at,account_week_id:h.weeks.get(key)??input.account_week_id};
  const result = await admit(h, input, id);
  assert.equal(result.admitted,true,`${id}: ${result.reason}`);
  h.owned.add(id);
  const initial=exposure(h.adapter.state().attempts.find(a=>a.id===id));
  for(const event of [
    {type:'launch_result',event_id:`${id}:started`,result:'started'},
    {type:'cleanup_proven',event_id:`${id}:cleanup-proven:1`,cleanup_removed:true}
  ]) assert.equal((await h.adapter.transition({...event,at:h.at,attempt_id:id},{expectedRevision:h.adapter.state().revision})).applied,true);
  const held=h.adapter.state().attempts.find(a=>a.id===id);
  assert.deepEqual(exposure(held),initial,'finish proves no provider coverage');
  assert.notEqual(held.hold_closed,true);
  await assertAdmissionCounts(h.adapter,id,request(`${id}:preview`,h.at));

}

test('sandpiper sequence: Claude resets, a Claude job runs, then Codex is still admitted', async t => {
  const h = harness(t);
  await admitAndFinishHeld(h, claude(CLAUDE_W1), 'claude-week-1');
  await admitAndFinishHeld(h, codex(CODEX_W1), 'codex-before-claude-reset');
  // Claude's week resets while Codex's week continues.
  await admitAndFinishHeld(h, claude(CLAUDE_W2), 'claude-after-reset');
  const back = await admit(h, codex(CODEX_W1), 'codex-after-claude-reset');
  assert.equal(back.admitted, true, `Codex must be admitted on its unchanged week (got ${back.reason})`);
  assert.equal(h.adapter.state().account_week_id, CODEX_W1);
  assert.deepEqual(h.adapter.state().provider_weeks, {seven_day: {account_week_id: CLAUDE_W2, resets_at: h.scopes.get(`seven_day:${CLAUDE_W2}`)[0].resets_at},
    'codex:10080': {account_week_id: CODEX_W1, resets_at: h.scopes.get(`codex:10080:${CODEX_W1}`)[0].resets_at}});
});

test('weeks can alternate between providers many times', async t => {
  const h = harness(t);
  for (let i = 0; i < 3; i += 1) {
    await admitAndFinishHeld(h, claude(CLAUDE_W1), `claude-${i}`);
    await admitAndFinishHeld(h, codex(CODEX_W1), `codex-${i}`);
  }
  assert.equal(h.adapter.state().attempts.length, 6);
});

test('a reading from an earlier week of the same provider is refused', async t => {
  const h = harness(t);
  await admitAndFinishHeld(h, codex(CODEX_W1), 'codex-week-1');
  await admitAndFinishHeld(h, codex(CODEX_W2), 'codex-week-2');
  await admitAndFinishHeld(h, claude(CLAUDE_W1), 'claude-between');
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
  await admitAndFinishHeld(h, codex(CODEX_W2), 'codex-week-2');
  await admitAndFinishHeld(h, claude(CLAUDE_W1), 'claude');
  const before = h.adapter.state();
  const earlier = await admit(h, codex(`${ACCOUNT}:weekly:${NOW + 2 * DAY_MS}`, {resetAt: NOW + 2 * DAY_MS}), 'unseen-earlier');
  assert.equal(earlier.reason, 'account_week_identity');
  assert.deepEqual(h.adapter.state(), before);
});

test('a week whose reset has passed never becomes the current week', async t => {
  const h = harness(t);
  await admitAndFinishHeld(h, claude(CLAUDE_W1), 'claude');
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
    await admitAndFinishHeld(h, codex(CODEX_W1), 'codex-week-1');
    // Codex resets: the move to its new week persists, but this job is refused (lending is paused).
    await settleOwnResets(h.adapter,'codex-week-1');
    h.advance(h.adapter.state().updated_at);
    const paused = codex(CODEX_W2);
    paused.controls = {...paused.controls, paused: true};
    assert.equal((await admit(h, paused, 'codex-week-2-paused')).admitted, false);
    assert.equal(h.adapter.state().account_week_id, CODEX_W2);
    await admitAndFinishHeld(h, claude(CLAUDE_W1), 'claude');
    // Write the state as an older build would have: no provider_weeks.
    const legacy = h.adapter.state();
    delete legacy.provider_weeks;
    fs.writeFileSync(file, JSON.stringify(legacy));
  }
  const h = harness(t, {directory, week: CLAUDE_W1,at:JSON.parse(fs.readFileSync(file,'utf8')).updated_at});
  const back = await admit(h, codex(CODEX_W2), 'codex-week-2');
  assert.equal(back.admitted, true, `the newer Codex week must be admitted (got ${back.reason})`);
  assert.equal(h.adapter.state().provider_weeks['codex:10080'].account_week_id, CODEX_W2);
});

test('a reading that maps one provider meter to the week another meter holds is refused', async t => {
  const h = harness(t);
  await admitAndFinishHeld(h, claude(CLAUDE_W1), 'claude');
  await admitAndFinishHeld(h, codex(CODEX_W1), 'codex');
  const crossed = await admit(h, claude(CODEX_W1), 'crossed');
  assert.equal(crossed.admitted, false);
  assert.equal(crossed.reason, 'account_week_identity');
  assert.equal(h.adapter.state().account_week_id, CODEX_W1);
});

test('migration: the stuck single-week state from a real lender admits Codex again', async t => {
  const state = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.equal(state.provider_weeks, undefined, 'the fixture predates provider weeks');
  const claudeWeek = state.account_week_id;
  const codexWeek = state.opening_tokens.map(row => row.account_week_id).find(week => week.endsWith(':weekly:1793893170000'));
  const oldClaudeWeek = state.opening_tokens.map(row => row.account_week_id).find(week => week.endsWith(':weekly:1793430000000'));
  assert.ok(codexWeek && oldClaudeWeek);
  const directory = fs.mkdtempSync(join(tmpdir(), 'provider-week-fixture-'));
  fs.writeFileSync(join(directory, 'lending-pace50-state.json'), JSON.stringify(state));
  const at = state.updated_at + 60_000;
  const h = harness(t, {directory, account: state.account, week: claudeWeek, at});
  const reading = build({account: state.account, week: codexWeek, weeklyId: 'codex:10080', resetAt: 1793893170000,
    now: at, usedMicro: 62 * MICRO});
  h.set(reading);
  const preview = await h.adapter.preview({request: request('fixture-preview', at)});
  assert.notEqual(preview.reason, 'account_week_identity', 'preview must project the Codex week');
  const result = await admit(h, reading, 'fixture-codex');
  assert.notEqual(result.reason, 'account_week_identity', 'admission must move to the Codex week');
  const after = h.adapter.state();
  assert.equal(after.account_week_id, codexWeek);
  assert.deepEqual(after.provider_weeks, {seven_day: {account_week_id: claudeWeek, resets_at: 1794034800000},
    'codex:10080': {account_week_id: codexWeek, resets_at: 1793893170000}},
    'the migrated state records each meter\'s latest week');
  const stale = await admit(h, build({account: state.account, week: oldClaudeWeek, weeklyId: 'seven_day',
    resetAt: at + DAY_MS, now: at}), 'fixture-stale-claude');
  assert.equal(stale.reason, 'account_week_identity', 'an earlier Claude week stays refused after migration');
});
