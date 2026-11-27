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

// Usage the lender cannot read is unknown, and an unknown burn keeps its exposure held. A job's zero report is not proof that
// the provider meter has caught up. Positive costs are rounded up, never down to nothing.
const MICRO = 1000000;
const NOW = Date.parse('2026-10-23T06:40:00Z');
const FIVE = Date.parse('2026-10-23T08:40:00Z');
const WEEK = Date.parse('2026-10-30T02:00:00Z');
const ACCOUNT = 'f12e3786d2837824';
const EMAIL = 'aaaa0000bbbb1111';
const CLAUDE_AUTH = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
const windowsAt = (five, week) => [
  {window_id: 'seven_day', window_minutes: 10080, used_pct: week, resets_at: WEEK, observed_at: NOW, state: 'open'},
  {window_id: 'five_hour', window_minutes: 300, used_pct: five, resets_at: FIVE, observed_at: NOW, state: 'open'},
];
const JOB = {requirements: {limits: {wall_seconds: 240}}, expires_at: null, budget_v1: {max_list_usd: 1.5}};

function candidateFor(directory, meter) {
  const src = source.createRealPace50Source({
    readings: async () => ({windows: meter.value}),
    funding: async () => ({extra_usage: 'disabled', guest_auth: CLAUDE_AUTH, observed_at: NOW,
      identity: {account_sha256_16: ACCOUNT, email_sha256_16: EMAIL},
      executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2'},
      stop: {delivered: true, fallback: null, latency_ms: 700, removed: true}}),
    expectedIdentity: async () => ({email_sha256_16: EMAIL}),
    expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true}, stopBoundMs: 30000,
    windowOrigin: async () => new Map([['five_hour', 'owner'], ['seven_day', 'owner']]),
  });
  return createPace50Candidate({objectiveInputFor, contextFor: () => ({plan: 'max20'}), directory, now: () => NOW, account: ACCOUNT, account_week_id: `${ACCOUNT}:weekly:${WEEK}`,
    source: src, ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 1.5})}});
}

// One admitted chunk, started and cleaned up. The caller then settles it with whatever usage it has.
async function startedChunk(directory) {
  const meter = {value: windowsAt(24, 5)};
  const {candidate, adapter} = candidateFor(directory, meter);
  const reserved = await candidate.reserve({attemptId: 'attempt-usage', jobId: 'job-usage', provider: 'claude',
    model: 'claude-haiku-5-5', job: JOB, automatic: true, ownerAbsent: true});
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  await candidate.started('attempt-usage', {ok: true});
  candidate.recordCleanup('attempt-usage', {removed: true});
  const attempt = () => adapter.state().attempts.find((a) => a.id === 'attempt-usage');
  return {candidate, adapter, attempt};
}

const resultLine = (fields) => JSON.stringify({type: 'result', subtype: 'success', is_error: false, ...fields});
const AFFIRMATIVE_ZERO = resultLine({total_cost_usd: 0, usage: {input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0}});
const withDir = async (name, body) => {
  const dir = mkdtempSync(join(tmpdir(), name));
  try {
    await body(dir);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
};

const heldEverywhere = (attempt) => attempt.resources.every((r) => r.held_micro > 0);

test('absent usage (the job wrote no result) is unknown: the cessation is refused and the exposure stays held', () => withDir('usage-absent-', async (dir) => {
  const {candidate, attempt} = await startedChunk(dir);
  const out = await candidate.finish({attemptId: 'attempt-usage', provider: 'claude', model: 'claude-haiku-5-5', execution: {stdout: ''}});
  assert.equal(out.cessation.applied, false);
  assert.equal(out.cessation.reason, 'usage_unknown');
  assert.equal(attempt().process_state, 'ceased', 'cleanup proves process exit, not usage settlement');
  assert.equal(attempt().hold_closed, false);
  assert.ok(heldEverywhere(attempt()), 'nothing was released for usage nobody measured');
}));

test('malformed usage (a non-numeric or negative cost on the result) is unknown and stays held', async () => {
  for (const cost of ['abc', -1, null]) {
    await withDir('usage-malformed-', async (dir) => {
      const {candidate, attempt} = await startedChunk(dir);
      const out = await candidate.finish({attemptId: 'attempt-usage', provider: 'claude', model: 'claude-haiku-5-5',
        execution: {stdout: resultLine({total_cost_usd: cost})}});
      assert.equal(out.cessation.reason, 'usage_unknown', `cost ${JSON.stringify(cost)}`);
      assert.ok(heldEverywhere(attempt()), `cost ${JSON.stringify(cost)} released nothing`);
    });
  }
});

test('an error result with no cost is unknown and stays held, not zero', () => withDir('usage-error-', async (dir) => {
  const {candidate, attempt} = await startedChunk(dir);
  const out = await candidate.finish({attemptId: 'attempt-usage', provider: 'claude', model: 'claude-haiku-5-5',
    execution: {stdout: resultLine({is_error: true, subtype: 'error_during_execution'})}});
  assert.equal(out.cessation.reason, 'usage_unknown');
  assert.ok(heldEverywhere(attempt()));
}));

test('an unpriced model with no reported cost is unknown and stays held, not priced at zero', () => withDir('usage-unpriced-', async (dir) => {
  const {candidate, attempt} = await startedChunk(dir);
  const out = await candidate.finish({attemptId: 'attempt-usage', provider: 'claude', model: 'claude-no-such-model-9',
    execution: {stdout: resultLine({usage: {input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0}})}});
  assert.equal(out.cessation.reason, 'usage_unknown');
  assert.ok(heldEverywhere(attempt()));
}));

test('a positive cost below one micro-dollar is rounded up to a burn, not down to zero', () => withDir('usage-submicro-', async (dir) => {
  const {candidate, attempt} = await startedChunk(dir);
  await candidate.finish({attemptId: 'attempt-usage', provider: 'claude', model: 'claude-haiku-5-5',
    execution: {stdout: resultLine({total_cost_usd: 0.0000004})}});
  const burns = attempt().resources.map((r) => r.burns.map((b) => b.amount_micro));
  assert.ok(burns.every((list) => list.length === 1 && list[0] >= 1), `a burn was recorded: ${JSON.stringify(burns)}`);
  assert.ok(attempt().resources.every((r) => r.unrepresented_micro > 0), 'the sub-micro burn is held as unrepresented, not forgotten');
}));

test('a successful borrower result that reports zero tokens and zero cost does not release the hold', () => withDir('usage-zero-', async (dir) => {
  const {candidate, attempt} = await startedChunk(dir);
  const out = await candidate.finish({attemptId: 'attempt-usage', provider: 'claude', model: 'claude-haiku-5-5',
    execution: {stdout: AFFIRMATIVE_ZERO}});
  assert.equal(out.cessation.reason, 'usage_unknown');
  assert.equal(attempt().process_state, 'ceased', 'cleanup proves process exit, not the borrower-reported usage total');
  assert.equal(attempt().hold_closed, false);
  assert.ok(heldEverywhere(attempt()));
}));

test('a prepared attempt released after an error with no usage is held, because the job may have spent', () => withDir('usage-release-', async (dir) => {
  const {candidate, attempt} = await startedChunk(dir);
  const out = await candidate.release('attempt-usage', {reason: 'error', prepared: true});
  assert.equal(out.applied, false, 'a possibly-run job is not released without usage');
  assert.ok(heldEverywhere(attempt()));
}));

// An admitted chunk that nothing prepared or launched: reserved, with no start and no cleanup.
async function admittedChunk(directory) {
  const meter = {value: windowsAt(24, 5)};
  const {candidate, adapter} = candidateFor(directory, meter);
  const reserved = await candidate.reserve({attemptId: 'attempt-usage', jobId: 'job-usage', provider: 'claude',
    model: 'claude-haiku-5-5', job: JOB, automatic: true, ownerAbsent: true});
  assert.equal(reserved.ok, true, JSON.stringify(reserved));
  return {candidate, adapter, attempt: () => adapter.state().attempts.find((a) => a.id === 'attempt-usage')};
}

test('a chunk nobody prepared is released without usage: that absence is the zero-use evidence', () => withDir('usage-absent-prep-', async (dir) => {
  const {candidate, attempt} = await admittedChunk(dir);
  const out = await candidate.release('attempt-usage', {reason: 'error', prepared: false});
  assert.equal(out.applied, true);
  assert.equal(attempt().process_state, 'ceased');
}));

test('a started attempt cannot close from a boolean zero-use report', () => withDir('usage-policy-', async (dir) => {
  const {candidate, adapter} = await startedChunk(dir);
  const attested = await adapter.transition({type: 'cessation_proven', event_id: 'attested', at: NOW, attempt_id: 'attempt-usage',
    authoritative_cessation: true, usage_reconciled: true, zero_use_attested: true}, {expectedRevision: adapter.state().revision});
  assert.equal(attested.applied, false, 'a started run needs provider evidence, regardless of a borrower-controlled boolean');
  assert.equal(attested.reason, 'usage_uncovered');
  assert.ok(heldEverywhere(adapter.state().attempts[0]));
  void candidate;
}));

test('a zero-amount burn cannot stand in for no-use proof', () => withDir('usage-policy-zero-', async (dir) => {
  const {candidate, adapter} = await startedChunk(dir);
  const zeroBurn = await adapter.transition({type: 'usage', event_id: 'zero-burn', burn_id: 'zero-burn', at: NOW,
    attempt_id: 'attempt-usage', resources: adapter.state().attempts[0].resources.map(r =>
      ({id: r.id, instance: r.instance, amount_micro: 0}))}, {expectedRevision: adapter.state().revision});
  assert.equal(zeroBurn.applied, false, 'zero is not measured usage');
  assert.equal(zeroBurn.reason, 'usage_vector_invalid');
  assert.ok(heldEverywhere(adapter.state().attempts[0]));
  void candidate;
}));

// A saved reading can outlive the 15 min that a not-open five-hour window stands on its probe. Admission reads the saved reading,
// so the window is unknown there until the next probe. While the saved reading is that old, that is pending evidence and a
// refresh request. A fresh reading that still lacks the window is a real gap and refuses.
test('admission on a saved reading whose not-open window went stale waits for a fresh reading', async () => {
  const fact = {extra_usage: 'disabled', guest_auth: CLAUDE_AUTH, observed_at: NOW,
    identity: {account_sha256_16: ACCOUNT, email_sha256_16: EMAIL},
    executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.51.0'}, stop: {delivered: true, fallback: null, latency_ms: 700, removed: true}};
  const weekly = {window_id: 'seven_day', window_minutes: 10080, used_pct: 33, resets_at: WEEK, observed_at: NOW, state: 'open', source: 'probe'};
  const shortAs = state => ({window_id: 'five_hour', window_minutes: 300, used_pct: 0, resets_at: null, observed_at: NOW, state, source: 'probe'});
  const sourceWith = (windows, ageMs) => {
    const refreshes = [];
    const readings = Object.assign(async () => ({windows}), {cached: () => ({windows, age_ms: ageMs}), requestRefresh: provider => refreshes.push(provider)});
    const src = source.createRealPace50Source({readings, funding: async () => fact, expectedIdentity: async () => ({email_sha256_16: EMAIL}),
      expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true}, stopBoundMs: 30000, windowOrigin: async () => new Map([['seven_day', 'owner']])});
    return {src, refreshes};
  };

  const stale = sourceWith([weekly, shortAs('unknown')], 16 * 60000);
  const held = await stale.src.observe({provider: 'claude', admissionOnly: true});
  assert.equal(held.complete, false);
  assert.equal(held.evidence_pending, true);
  assert.deepEqual(realSource.observationProofFailures(held), ['objective_evidence_unknown']);
  assert.deepEqual(stale.refreshes, ['claude'], 'the stale reading asks for a fresh one');

  // A fresh not-open window opens cold at its probe bound, so the same roster is complete and nothing is pending.
  const fresh = sourceWith([weekly, shortAs('not_open')], 0);
  const ready = await fresh.src.observe({provider: 'claude', admissionOnly: true});
  assert.equal(ready.complete, true);
  assert.equal(ready.evidence_pending, undefined);
  assert.equal(realSource.observationProofFailures(ready).includes('resources_incomplete'), false);
  assert.deepEqual(fresh.refreshes, []);

  // A fresh probe that left the window out does not hold forever: the gap refuses, and nothing asks for another probe.
  const gap = sourceWith([weekly, shortAs('unknown')], 60000);
  const refused = await gap.src.observe({provider: 'claude', admissionOnly: true});
  assert.equal(refused.evidence_pending, undefined);
  assert.deepEqual(realSource.observationProofFailures(refused).filter(r => r === 'resources_incomplete'), ['resources_incomplete']);
  assert.deepEqual(gap.refreshes, []);

  // A live (non-admission) read keeps its own answer: an unplaced window there is incomplete, not pending.
  const live = await stale.src.observe({provider: 'claude'});
  assert.equal(live.evidence_pending, undefined);
  assert.deepEqual(realSource.observationProofFailures(live).filter(r => r === 'resources_incomplete'), ['resources_incomplete']);
});
