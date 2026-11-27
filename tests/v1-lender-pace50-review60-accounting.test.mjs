import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd} from '../lib/v1/lending-meter.mjs';
import {createSyntheticPace50Source, SYNTHETIC_RESET} from './helpers/pace50-synthetic-source.mjs';
import {ACCOUNT, WEEK, NOW, MICRO} from './helpers/pace50-fixtures.mjs';

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'r60-'));
  const clock = {at: NOW};
  const source = createSyntheticPace50Source({start: NOW, ...options});
  const pace = createPace50Candidate({postingLagBoundMs:120000,directory, now: () => clock.at, account: ACCOUNT, account_week_id: WEEK, source,
    contextFor: () => ({consent: true, people: true, agents: true, schedule: true, unexpired: true, plan: 'max20'})});
  t.after(async () => {await pace.adapter.close(); fs.rmSync(directory, {recursive: true, force: true});});
  const reserve = (id, more = {}) => pace.candidate.reserve({attemptId: id, jobId: id, provider: 'claude',
    model: 'claude-haiku-5-5', job: {budget_v1: {max_list_usd: 10}, requirements: {limits: {wall_seconds: 300}},
      expires_at: new Date(NOW + 7 * 86400e3).toISOString()}, automatic: true, ownerAbsent: true, ...more});
  const attempt = (id) => pace.adapter.state().attempts.find((a) => a.id === id);
  return {...pace, source, clock, reserve, attempt};
}

// The declared whole-point unit takes one point off the weekly spare. Each reading here is one point higher than the exact-meter
// reading it replaces (99.5 becomes 98.5, 99 becomes 98), so the spare the test is about stays the same.
test('concurrent admissions never commit the same revision twice', async (t) => {
  const f = fixture(t, {used: {weekly: 98.5 * MICRO, short: 40 * MICRO}});
  const results = await Promise.all([f.reserve('a'), f.reserve('b')]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(f.adapter.state().attempts.length, 1);
});

// The most a run may spend: its reserved exposure, in USD, less one worst-case call of its model.
const guardCostUsd = (f, id) => Math.min(...f.attempt(id).resources.map((r) => r.initial_micro / r.kappa_micro)) - claudeCallHeadroomUsd('claude-haiku-5-5');

test('two live attempts cannot reconcile separate burns against the same partial aggregate delta', async (t) => {
  const f = fixture(t, {used: {weekly: 98 * MICRO, short: 40 * MICRO}});
  assert.equal((await f.reserve('a')).ok, true);
  await f.candidate.started('a', {ok: true});
  assert.equal((await f.reserve('b')).ok, true);
  await f.candidate.started('b', {ok: true});
  assert.equal((await f.reserve('before')).ok, false, 'both objective-sized holds exhaust the weekly slack');
  // The provider read has caught up with only part of the two live attempts' usage.
  f.source.state.used.weekly += .2 * MICRO;
  f.source.state.used.short += .8 * MICRO;
  for (const id of ['a', 'b']) {
    f.clock.at += 1000;
    f.candidate.recordCleanup(id, {removed: true});
    const out = await f.candidate.finish({attemptId: id, provider: 'claude', model: 'claude-haiku-5-5',
      execution: {stdout: '', lending_meter: {cost_usd: guardCostUsd(f, id), final: true}}});
    assert.ok(out, `settlement returns a durable result for ${id}`);
  }
  const unrepresented = f.adapter.state().attempts.flatMap((a) => a.resources).filter((r) => r.kind === 'weekly')
    .reduce((n, r) => n + r.unrepresented_micro, 0);
  const next = await f.reserve('after');
  // No run is credited with more than the provider read supports: represented burns never exceed the aggregate movement behind them.
  for (const id of ['a', 'b']) {
    const weekly = f.attempt(id).resources.find((r) => r.kind === 'weekly');
    assert.ok(weekly.aggregate_used_micro - weekly.baseline_used_micro >= weekly.spent_micro - weekly.unrepresented_micro,
      `${id}: represented burns exceed the aggregate movement that supports them`);
  }
  assert.equal(next.ok, false, 'actual weekly spend plus the new hold would exceed available slack');
});

test('an unresolved weekly charge stays held while the objective admits only remaining spare', async (t) => {
  const f = fixture(t, {override: ({base, now}) => ({...base, resources: base.resources.map((r) => {
    if (r.kind === 'short' && now >= NOW + SYNTHETIC_RESET.short) return {...r, instance: 'synthetic-short-2',
      anchor_at: NOW + SYNTHETIC_RESET.short, resets_at: NOW + SYNTHETIC_RESET.short + 5 * 3600000,
      used_micro: 0, origin: 'owner'};
    return r;
  })})});
  assert.equal((await f.reserve('a')).ok, true);
  await f.candidate.started('a', {ok: true});
  await f.candidate.finish({attemptId: 'a', provider: 'claude', model: 'claude-haiku-5-5', execution: {stdout: ''}});
  await f.candidate.recordCleanup('a', {removed: true});
  f.clock.at = NOW + SYNTHETIC_RESET.short + 3 * 3600000;
  f.source.state.used.weekly = 53.9 * MICRO;
  await f.candidate.probeHeld();
  const weekly = f.attempt('a').resources.find((r) => r.kind === 'weekly');
  const next = await f.reserve('after-reset');
  assert.ok(weekly.unrepresented_micro > 0, 'charging the old hold cannot prove it is in the live weekly meter');
  assert.equal(next.ok, true, 'a held charge is not a global block while known spare remains');
  const nextWeekly = f.attempt('after-reset').resources.find((r) => r.kind === 'weekly');
  assert.ok(f.source.state.used.weekly + weekly.unrepresented_micro + nextWeekly.initial_micro <= 100 * MICRO,
    'meter usage, unresolved charge and new reservation remain inside the physical weekly window');
});

test('a late start across reset needs current-window reconciliation before resumption', async (t) => {
  const f = fixture(t, {override: ({base, now}) => ({...base, resources: base.resources.map((r) =>
    r.kind === 'short' && now >= NOW + SYNTHETIC_RESET.short ? {...r, instance: 'synthetic-short-2',
      anchor_at: NOW + SYNTHETIC_RESET.short, resets_at: NOW + SYNTHETIC_RESET.short + 5 * 3600000, used_micro: 0} : r)})});
  assert.equal((await f.reserve('a')).ok, true);
  f.clock.at = NOW + SYNTHETIC_RESET.short + 3 * 3600000;
  await f.candidate.started('a', {ok: true});
  assert.equal(f.attempt('a').late_ack_unresolved, true);
  await f.candidate.finish({attemptId: 'a', provider: 'claude', model: 'claude-haiku-5-5', execution: {stdout: ''}});
  f.candidate.recordCleanup('a', {removed: true});
  await f.candidate.probeHeld();
  const next = await f.reserve('after-late-reset');
  assert.equal(f.attempt('a').late_ack_unresolved, true, 'an old-window full charge is not a current-window reconciliation');
});

test('stale reading and held exposure larger than room both refuse admission without another hold', async (t) => {
  let stale = false;
  const f = fixture(t, {override: ({base, now}) => ({...base, resources: base.resources.map((r) =>
    ({...r, observed_at: stale ? now - 60001 : now}))})});
  assert.equal((await f.reserve('a')).ok, true);
  f.source.state.used.short = 100 * MICRO;
  const exhausted = await f.reserve('b');
  assert.equal(exhausted.ok, false);
  assert.equal(exhausted.policyReason, 'budget_too_small', 'a full physical window leaves no objective-sized chunk');
  stale = true;
  assert.equal((await f.reserve('c')).ok, false);
  assert.equal(f.adapter.state().attempts.length, 1);
});
