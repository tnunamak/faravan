import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildAttemptEvidence, attemptEvidenceFromState, PARSER_QUANTIZATION_PP} from '../lib/v1/attempt-evidence.mjs';

const proof = {source: 'synthetic_fixture', evidence_sha256: 'a'.repeat(64)};
const fixture = () => ({attempt_id: 'attempt-1', provider: 'claude',
  admission: {requested_usd_micro: 10_000_000, gross_reserved_usd_micro: 10_000_000,
    native_budget_usd_micro: 8_000_000, admitted_at: 10_000, stop_allowance_ms: 1000,
    stop_allowance_provenance: proof, conversion_version: 'fixture/1', resources: [
      {window_id: 'five_hour', instance: 'window-1', epoch: 'epoch-1', resets_at: 18_000_000,
        gross_reserved_cap_pp: 2, points_per_usd_micro: 200_000, conversion_version: 'fixture/1', conversion_provenance: proof}]},
  guard_estimate: {model: 'synthetic-model', unit: 'claude_usd', used_units: 1, cost_usd: 1,
    catalog_revision: 'synthetic/1', tokens: {input: 20, output: 10}},
  before: [{window_id: 'five_hour', window_minutes: 300, instance: 'window-1', epoch: 'epoch-1', resets_at: 18_000_000,
    used_pct: 10, observed_at: 9000, received_at: 9000, source: 'probe'}],
  after: [{window_id: 'five_hour', window_minutes: 300, instance: 'window-1', epoch: 'epoch-1', resets_at: 18_000_000,
    used_pct: 11, observed_at: 21_000, received_at: 21_000, source: 'probe'}],
  bounds: [{window_id: 'five_hour', rounding: {upper_pp: 0.01, provenance: proof}, lag: {upper_ms: 0, provenance: proof}}],
  coverage: {identity: 'proven', account_wide: true, attribution: 'exclusive_attempt', provenance: proof,
    started_at: 10_000, stop_tail_ended_at: 20_000, stop_tail_provenance: proof},
  funding: {subscription_only: 'proven', evidence_sha256: 'b'.repeat(64)},
  ledger_snapshot: {version: 'synthetic/1', revision: 3}, ledger_entries: [
    {attempt_id: 'attempt-1', window_id: 'five_hour', lent_pts: 1, charged_pts: 1, attribution: 'exact'},
    {attempt_id: 'other-attempt', window_id: 'five_hour', charged_pts: 99}],
});
const row = input => buildAttemptEvidence(input).column_4.records[0];

test('bounded_usage keeps all four columns distinct and actual dollars unknown', () => {
  const input = fixture(), original = structuredClone(input), evidence = buildAttemptEvidence(input), actual = evidence.column_4.records[0];
  assert.equal(evidence.column_4.classification, 'bounded_usage');
  assert.equal(evidence.column_2.label, 'ESTIMATE');
  assert.equal(evidence.column_2.cost_usd, 1);
  assert.equal(actual.actual_usd, null);
  assert.equal(evidence.column_4.actual_usd, null);
  assert.equal(actual.raw_delta_pp, 1);
  assert.equal(actual.parser_quantization_pp, 0.001);
  assert.equal(actual.account_consumption_upper_pp, 1 + 0.01 + PARSER_QUANTIZATION_PP);
  assert.equal(actual.job_consumption_upper_pp, actual.account_consumption_upper_pp);
  assert.equal(evidence.column_4.ledger_entries.length, 1);
  assert.match(actual.before_evidence_sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(input, original, 'the pure builder must not mutate input');
});

test('violation requires a proven attempt-only lower bound above the cap', () => {
  const input = fixture(); input.after[0].used_pct = 13;
  const actual = row(input);
  assert.equal(actual.classification, 'violation');
  assert.ok(actual.job_consumption_lower_pp > actual.gross_cap_pp);
});

test('an interval straddling the cap is unknown, not a violation', () => {
  const input = fixture(); input.after[0].used_pct = 12;
  const actual = row(input);
  assert.equal(actual.classification, 'unknown');
  assert.ok(actual.job_consumption_lower_pp < 2 && actual.job_consumption_upper_pp > 2);
  assert.ok(actual.missing_bound_reasons.includes('cap_not_proven_by_upper_bound'));
});

test('a proven usage-cap violation is not erased by unknown funding-path evidence', () => {
  const input = fixture(); input.after[0].used_pct = 13; delete input.funding;
  const actual = row(input);
  assert.equal(actual.classification, 'violation');
  assert.ok(actual.job_consumption_lower_pp > actual.gross_cap_pp);
  assert.ok(actual.missing_bound_reasons.includes('subscription_path_unknown'));
  assert.equal(actual.actual_usd, null);
});

test('account-wide concurrent use is an upper bound, never an exact job charge', () => {
  const input = fixture(); input.coverage.attribution = 'account_upper_only';
  assert.equal(row(input).classification, 'bounded_usage');
  input.after[0].used_pct = 13;
  assert.equal(row(input).classification, 'unknown');
  assert.equal(row(input).job_consumption_lower_pp, null);
});

test('unknown lag is null rather than zero', () => {
  const input = fixture(); delete input.bounds[0].lag;
  assert.equal(row(input).provider_lag_bound_ms, null);
  assert.equal(row(input).job_consumption_upper_pp, null);
  assert.ok(row(input).missing_bound_reasons.includes('provider_lag_bound_unknown'));
});

test('unknown provider rounding cannot borrow parser precision', () => {
  const input = fixture(); delete input.bounds[0].rounding;
  assert.equal(row(input).classification, 'unknown');
  assert.equal(row(input).account_consumption_upper_pp, null);
  assert.ok(row(input).missing_bound_reasons.includes('provider_rounding_bound_unknown'));
});

test('zero bounds without provenance are still unknown', () => {
  const input = fixture(); input.bounds[0].rounding = {upper_pp: 0}; input.bounds[0].lag = {upper_ms: 0};
  assert.equal(row(input).classification, 'unknown');
  assert.equal(row(input).account_consumption_upper_pp, null);
});

test('positive receipt age and provider lag require an account-wide rate bound', () => {
  const input = fixture(); input.after[0].received_at += 1000; input.bounds[0].lag.upper_ms = 500;
  assert.ok(row(input).missing_bound_reasons.includes('account_wide_rate_bound_unknown'));
  input.bounds[0].rate = {upper_pp_per_hour: 3.6, provenance: proof};
  const actual = row(input);
  assert.equal(actual.unrepresented_delay_ms, 2000);
  assert.equal(actual.unrepresented_lag_allowance_pp, 0.002);
  assert.equal(actual.classification, 'bounded_usage');
});

test('reset crossing without independent per-epoch evidence is unknown', () => {
  const input = fixture(); input.after[0].resets_at += 18_000_000;
  const actual = row(input);
  assert.equal(actual.reset_crossing, true);
  assert.equal(actual.account_consumption_upper_pp, null);
  assert.equal(actual.classification, 'unknown');
});

test('negative same-epoch delta is inconsistent and is not clamped to zero', () => {
  const input = fixture(); input.after[0].used_pct = 9;
  const actual = row(input);
  assert.equal(actual.raw_delta_pp, -1);
  assert.equal(actual.classification, 'unknown');
  assert.equal(actual.account_consumption_upper_pp, null);
  assert.ok(actual.missing_bound_reasons.includes('inconsistent_negative_same_epoch_delta'));
});

test('missing after-reading is unknown, even when the ledger reports an exact charge', () => {
  const input = fixture(); input.after = [];
  assert.equal(row(input).evidence_kind, 'unknown');
  assert.equal(row(input).classification, 'unknown');
  assert.equal(row(input).after_evidence_sha256, null);
});

test('empty input never passes', () => {
  assert.equal(buildAttemptEvidence().column_4.classification, 'unknown');
  assert.deepEqual(buildAttemptEvidence().column_4.missing_bound_reasons, ['empty_record']);
});

test('missing stop-tail evidence or insufficient bracketing blocks numeric bounds', () => {
  const input = fixture(); input.coverage.stop_tail_ended_at = 22_000;
  assert.equal(row(input).job_consumption_upper_pp, null);
  input.coverage.stop_tail_ended_at = 20_000; delete input.coverage.stop_tail_provenance;
  assert.ok(row(input).missing_bound_reasons.includes('execution_and_stop_tail_not_bracketed'));
});

test('unknown identity, coverage and subscription evidence do not qualify', () => {
  const input = fixture(); input.coverage.identity = 'unknown';
  assert.equal(row(input).job_consumption_upper_pp, null);
  input.coverage.identity = 'proven'; input.coverage.account_wide = false;
  assert.equal(row(input).job_consumption_upper_pp, null);
  input.coverage.account_wide = true; delete input.funding;
  assert.equal(row(input).classification, 'unknown');
  assert.ok(row(input).missing_bound_reasons.includes('subscription_path_unknown'));
});

test('strict projection excludes credentials, email, raw environments and headers at every level', () => {
  const input = fixture();
  const poison = {credential: 'DO-NOT-COPY', email: 'secret@example.test', environment: {OPENAI_API_KEY: 'DO-NOT-COPY'},
    headers: {Authorization: 'Bearer DO-NOT-COPY'}};
  Object.assign(input, poison); Object.assign(input.admission, poison); Object.assign(input.admission.resources[0], poison);
  Object.assign(input.guard_estimate, poison); Object.assign(input.before[0], poison); Object.assign(input.after[0], poison);
  Object.assign(input.coverage, poison); Object.assign(input.funding, poison); Object.assign(input.bounds[0], poison);
  Object.assign(input.ledger_entries[0], poison);
  const actual = buildAttemptEvidence(input), encoded = JSON.stringify(actual);
  assert.doesNotMatch(encoded, /DO-NOT-COPY|secret@example|Authorization|OPENAI_API_KEY|credential|environment|headers|email/);
  assert.equal(actual.column_4.classification, 'bounded_usage');
  const changed = structuredClone(input); changed.before[0].headers.Authorization = 'different secret';
  assert.equal(row(input).before_evidence_sha256, row(changed).before_evidence_sha256, 'hash only the sanitized reading');
});

test('duplicate observations and mismatched cap epoch cannot silently qualify', () => {
  const input = fixture(); input.before.push({...input.before[0]});
  assert.equal(row(input).classification, 'unknown');
  input.before.pop(); input.admission.resources[0].epoch = 'other';
  assert.equal(row(input).gross_cap_pp, null);
  assert.equal(row(input).classification, 'unknown');
});

test('invalid window keys or an unknown provider cannot silently qualify', () => {
  const input = fixture(); input.admission.resources.push({window_id: 'invalid@example.test'});
  assert.equal(buildAttemptEvidence(input).column_4.classification, 'unknown');
  assert.ok(buildAttemptEvidence(input).column_4.missing_bound_reasons.includes('invalid_window_key'));
  input.admission.resources.pop(); input.provider = 'unknown';
  assert.equal(row(input).account_consumption_upper_pp, null);
  assert.ok(row(input).missing_bound_reasons.includes('provider_unknown'));
});

test('arithmetic overflow and invalid chronological evidence stay unknown', () => {
  const input = fixture(); input.bounds[0].lag.upper_ms = Number.MAX_VALUE;
  input.bounds[0].rate = {upper_pp_per_hour: Number.MAX_VALUE, provenance: proof};
  assert.equal(row(input).account_consumption_upper_pp, null);
  assert.ok(row(input).missing_bound_reasons.includes('bound_arithmetic_overflow'));
  input.bounds[0].lag.upper_ms = 0; input.after[0].received_at = 20_000;
  assert.equal(row(input).account_consumption_upper_pp, null);
  assert.ok(row(input).missing_bound_reasons.includes('observation_or_receipt_time_unknown'));
});

test('raw meter contract identifies the reset epoch without invented instance or epoch labels', () => {
  const input = fixture();
  delete input.before[0].epoch; delete input.after[0].epoch; delete input.admission.resources[0].epoch;
  delete input.before[0].instance; delete input.after[0].instance; delete input.admission.resources[0].instance;
  assert.equal(row(input).classification, 'bounded_usage');
});

test('a durable snapshot projection cannot invent missing admission, receipt or stop facts', () => {
  const input = fixture(), snapshot = {version: 'objective-lending/state/4', revision: 8, attempts: [{id: 'attempt-1',
    created_at: 10_000, stop_ms: 1000, resources: [{id: 'five_hour', instance: 'window-1', epoch: 'epoch-1',
      duration_ms: 18_000_000, resets_at: 18_000_000, baseline_used_micro: 10_000_000,
      aggregate_observed_at: 21_000, aggregate_used_micro: 11_000_000, initial_micro: 2_000_000,
      kappa_micro: 200_000, settled_micro: 0, burns: [{id: 'burn-1', at: 20_000, amount_micro: 1_000_000}]}]}]};
  const original = structuredClone(snapshot), evidence = attemptEvidenceFromState(snapshot, input.attempt_id);
  assert.equal(evidence.column_4.classification, 'unknown');
  assert.equal(evidence.column_1.requested_usd_micro, null);
  assert.equal(evidence.column_3.before[0].observed_at, null);
  assert.equal(evidence.column_3.after[0].received_at, null);
  assert.equal(evidence.column_4.ledger_snapshot.revision, 8);
  assert.equal(evidence.column_4.ledger_entries[0].amount_micro, 1_000_000);
  assert.deepEqual(snapshot, original);
  assert.equal(attemptEvidenceFromState(snapshot, 'missing'), null);
});

test('runtime returns null for an unknown attempt without probing or writing', async t => {
  const {createLendingRuntime} = await import('../lib/v1/lending-runtime.mjs');
  const directory = fs.mkdtempSync(join(tmpdir(), 'attempt-evidence-runtime-empty-'));
  const untouched = () => { throw new Error('an evidence read must not invoke external callbacks'); };
  const runtime = createLendingRuntime({directory, settings: () => ({}), presence: untouched, readOverride: untouched, statusRead: untouched});
  t.after(async () => { await runtime.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  const before = fs.readdirSync(directory);
  assert.equal(runtime.attemptEvidence('missing'), null);
  assert.deepEqual(fs.readdirSync(directory), before);
});

test('runtime known-attempt evidence reads one snapshot and writes no state', async t => {
  const {createLendingRuntime} = await import('../lib/v1/lending-runtime.mjs');
  const {ACCOUNT, NOW, WEEK, ordinaryInput, request} = await import('./helpers/pace50-fixtures.mjs');
  const directory = fs.mkdtempSync(join(tmpdir(), 'attempt-evidence-runtime-known-'));
  let effects = 0, builds = 0, writes = 0;
  const runtime = createLendingRuntime({directory, settings: () => ({}), now: () => NOW, pace50: {
    account: ACCOUNT, account_week_id: WEEK, buildInput: async () => { builds++; return ordinaryInput({now: NOW}); },
    io: {writeAllSync(fd, value) { writes++; fs.writeFileSync(fd, value); }},
    effects: {arm_cessation_deadline: async () => { effects++; return () => {}; }, launch_chunk: async () => { effects++; },
      open_short_window: async () => { effects++; }, cancel_pending_attempt: async () => { effects++; },
      request_cessation: async () => { effects++; }, request_fresh_complete_reconciliation: async () => { effects++; }}}});
  t.after(async () => { await runtime.close(); fs.rmSync(directory, {recursive: true, force: true}); });
  await runtime.pace50.deliver({type: 'on', event_id: 'on-1', at: NOW});
  await runtime.pace50.deliver({type: 'owner_absent', event_id: 'absent-1', at: NOW});
  const admitted = await runtime.pace50.admit({request: request(), expectedRevision: runtime.pace50.state().revision});
  assert.equal(admitted.admitted, true);
  const snapshot = runtime.pace50.state(), file = join(directory, 'lending-pace50-state.json');
  const bytes = fs.readFileSync(file), stat = fs.statSync(file), names = fs.readdirSync(directory), calls = {effects, builds, writes};
  const state = runtime.pace50.state;
  let reads = 0;
  runtime.pace50.state = () => { reads++; return state(); };
  const evidence = runtime.attemptEvidence('attempt-1');
  assert.equal(reads, 1, 'one atomic durable revision supplies the entire record');
  runtime.pace50.state = state;
  assert.equal(evidence.attempt_id, 'attempt-1');
  assert.equal(evidence.column_4.classification, 'unknown');
  assert.deepEqual(runtime.pace50.state(), snapshot);
  assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.statSync(file).mtimeMs, stat.mtimeMs);
  assert.deepEqual(fs.readdirSync(directory), names);
  assert.deepEqual({effects, builds, writes}, calls);
  evidence.column_1.resources[0].gross_reserved_cap_pp = -1;
  assert.deepEqual(runtime.pace50.state(), snapshot, 'the output must not alias the stored state');
});
