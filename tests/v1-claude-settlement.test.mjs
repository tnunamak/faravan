import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as realSource from './helpers/real-source.mjs';
import {withOwnMeasurement} from './helpers/own-measurement.mjs';
const source = withOwnMeasurement(realSource);
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
// The real meter/conversion remains under test; only objective demand evidence is synthetic.
const objectiveInputFor = createSyntheticPace50Source().objectiveInputFor;
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';

const MICRO = 1000000;
const NOW = Date.parse('2026-10-23T06:40:00Z');
const FIVE = Date.parse('2026-10-23T08:40:00Z');
const WEEK = Date.parse('2026-10-30T02:00:00Z');
const ACCOUNT = 'f12e3786d2837824';
const EMAIL = 'aaaa0000bbbb1111';
const CLAUDE_AUTH = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
const RESULT_LINE = JSON.stringify({type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.004,
  usage: {input_tokens: 2, output_tokens: 291, cache_read_input_tokens: 11236, cache_creation_input_tokens: 22913}});

const windowsAt = (fiveUsedPct, weekUsedPct) => [
  {window_id: 'seven_day', window_minutes: 10080, used_pct: weekUsedPct, resets_at: WEEK, observed_at: NOW, state: 'open'},
  {window_id: 'five_hour', window_minutes: 300, used_pct: fiveUsedPct, resets_at: FIVE, observed_at: NOW, state: 'open'},
];

// The candidate reads the meter through `meter.value`, so a test can move the provider's reading between reserve and finish.
function admissibleCandidate(directory, meter) {
  const src = source.createRealPace50Source({
    readings: async () => ({windows: meter.value}),
    funding: async () => ({extra_usage: 'disabled', guest_auth: CLAUDE_AUTH, observed_at: NOW,
      identity: {account_sha256_16: ACCOUNT, email_sha256_16: EMAIL},
      executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2'},
      stop: {delivered: true, fallback: null, latency_ms: 700, removed: true}}),
    expectedIdentity: async () => ({email_sha256_16: EMAIL}),
    expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true},
    stopBoundMs: 30000,
    windowOrigin: async () => new Map([['five_hour', 'owner'], ['seven_day', 'owner']]),
  });
  return createPace50Candidate({objectiveInputFor, contextFor: () => ({plan: 'max20'}), directory, now: () => NOW, account: ACCOUNT, account_week_id: `${ACCOUNT}:weekly:${WEEK}`,
    source: src, ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 1.5})}});
}

test('convertUsage prices a burn at the reserved conversion, rounded up, and refuses to guess', () => {
  const src = source.createRealPace50Source({readings: async () => ({windows: []})});
  const reserved = [{id: 'five_hour', instance: `five_hour@${FIVE}`, kappa_micro: 6 * MICRO}];
  assert.deepEqual(src.convertUsage({units_micro: 4000, resources: reserved}),
    [{id: 'five_hour', instance: `five_hour@${FIVE}`, amount_micro: 24000}]);
  // 250000 × 3 / 1e6 is 0.75. A burn rounds up, so it is never understated.
  assert.equal(src.convertUsage({units_micro: 3, resources: [{...reserved[0], kappa_micro: 250000}]})[0].amount_micro, 1);
  assert.equal(src.convertUsage({units_micro: 4000, resources: [{...reserved[0], kappa_micro: null}]}), null);
  assert.equal(src.convertUsage({units_micro: 4000, resources: []}), null);
  assert.equal(src.convertUsage({units_micro: 1.5, resources: reserved}), null);
});

// One admitted chunk: reserve, start, clean up, then settle against the meter as the provider reads each window afterwards.
async function settleChunk(directory, after) {
  const meter = {value: windowsAt(24, 5)};
  const {candidate, adapter} = admissibleCandidate(directory, meter);
  const job = {requirements: {limits: {wall_seconds: 240}}, expires_at: null, budget_v1: {max_list_usd: 1.5}};
  const reserved = await candidate.reserve({attemptId: 'attempt-settle', jobId: 'job-settle', provider: 'claude',
    model: 'claude-haiku-5-5', job, automatic: true, ownerAbsent: true});
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await candidate.started('attempt-settle', {ok: true});
  candidate.recordCleanup('attempt-settle', {removed: true});
  // The provider's reset times jitter by about a second; `jitterMs` moves both across a whole-second boundary.
  meter.value = windowsAt(after.five, after.week).map((w) => ({...w, resets_at: w.resets_at + (after.jitterMs ?? 0)}));
  const out = await candidate.finish({attemptId: 'attempt-settle', provider: 'claude', model: 'claude-haiku-5-5',
    execution: {stdout: RESULT_LINE}});
  const attempt = adapter.state().attempts.find((a) => a.id === 'attempt-settle');
  return {out, attempt};
}

test('a whole-point tick on every reserved window does not prove this attempt is fully covered', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-tick-'));
  try {
    const {out, attempt} = await settleChunk(dir, {five: 25, week: 6});
    assert.ok(out.metered.units_micro > 0, 'the run priced some usage');
    assert.equal(out.cessation.applied, false, JSON.stringify(out.cessation));
    assert.equal(out.cessation.reason, 'usage_unreconciled');
    assert.equal(attempt.process_state, 'ceased');
    assert.equal(attempt.hold_closed, false);
    assert.ok(attempt.resources.every((r) => r.spent_micro > 0 && r.unrepresented_micro === r.spent_micro &&
      r.held_micro + r.unrepresented_micro === r.initial_micro && r.released_micro === 0));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('reset-time jitter does not turn aggregate movement into coverage proof', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-jitter-'));
  try {
    const {out, attempt} = await settleChunk(dir, {five: 25, week: 6, jitterMs: -40});
    assert.equal(out.cessation.applied, false, JSON.stringify(out.cessation));
    assert.equal(out.cessation.reason, 'usage_unreconciled');
    assert.equal(attempt.process_state, 'ceased');
    assert.deepEqual(attempt.resources.map((r) => r.instance).sort(), [`five_hour@${FIVE}`, `seven_day@${WEEK}`]);
    assert.equal(attempt.hold_closed, false);
    assert.ok(attempt.resources.every((r) => r.spent_micro > 0 && r.unrepresented_micro === r.spent_micro &&
      r.held_micro + r.unrepresented_micro === r.initial_micro && r.released_micro === 0));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('no whole-point tick: the cleaned-up process ceases but sub-point exposure stays held', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-flat-'));
  try {
    const {out, attempt} = await settleChunk(dir, {five: 24, week: 5});
    assert.equal(out.cessation.applied, false);
    assert.equal(out.cessation.reason, 'usage_unreconciled');
    assert.equal(attempt.process_state, 'ceased', 'cleanup proves process exit, not usage settlement');
    assert.equal(attempt.hold_closed, false);
    assert.ok(attempt.resources.every((r) => r.unrepresented_micro > 0 && r.unrepresented_micro < MICRO),
      'the burn is recorded but is below one whole point');
    assert.ok(attempt.resources.every((r) => r.held_micro > 0), 'the exposure is not released');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('a tick on one window is not enough: the other window still shows no burn, so the whole reconciliation is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settle-partial-'));
  try {
    const {out, attempt} = await settleChunk(dir, {five: 25, week: 5});
    assert.equal(out.cessation.applied, false);
    assert.equal(out.cessation.reason, 'usage_unreconciled');
    assert.equal(attempt.process_state, 'ceased', 'cleanup proves process exit, not usage settlement');
    assert.equal(attempt.hold_closed, false);
    assert.ok(attempt.resources.every((r) => r.unrepresented_micro > 0), 'no window is marked represented');
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
