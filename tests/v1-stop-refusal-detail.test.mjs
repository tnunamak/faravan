import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as realSource from '../lib/v1/lending-pace50-source.mjs';
import {withOwnMeasurement} from './helpers/own-measurement.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createMeasurementHistory} from '../lib/v1/event-history.mjs';

const source = withOwnMeasurement(realSource);
// Fixture values are hashes and readings, the only forms that reach admission. None is an account identifier.
const H = {account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888'};
const T = Date.parse('2026-10-23T06:00:00Z');
const FIVE = Date.parse('2026-10-23T08:40:00Z');
const WEEK = Date.parse('2026-10-30T02:00:00Z');
const BOUND_MS = 30000;
const CLAUDE_AUTH = {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'};
const IDENTITY = {account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org};
const EXECUTOR = {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2 5d40fd43027b33ed1f1a39c14fb07e2503d6998f'};
const EXPECTED_EXECUTOR = {backend_id: 'docker-sbx', accepts: () => true};
const windows = [
  {window_id: 'seven_day', window_minutes: 10080, used_pct: 4, resets_at: WEEK, observed_at: T, state: 'open'},
  {window_id: 'five_hour', window_minutes: 300, used_pct: 16, resets_at: FIVE, observed_at: T, state: 'open'},
];
const runSource = stop => source.createRealPace50Source({
  readings: async () => ({windows}),
  funding: async () => ({extra_usage: 'disabled', observed_at: T, guest_auth: CLAUDE_AUTH, identity: IDENTITY}),
  stopEvidence: async () => ({executor: EXECUTOR, stop, measured_at: T}),
  expectedIdentity: async () => ({email_sha256_16: H.email}),
  expectedExecutor: EXPECTED_EXECUTOR, stopBoundMs: BOUND_MS,
});

async function refuseWithStop(directory, stop) {
  const history = createMeasurementHistory({directory: join(directory, 'history')});
  const {candidate} = createPace50Candidate({directory, now: () => T, account: H.account,
    account_week_id: `${H.account}:weekly:${WEEK}`, contextFor: () => ({plan: 'max20'}), source: runSource(stop),
    ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 4})}, measurementHistory: history});
  const out = await candidate.reserve({attemptId: 'stop-attempt-1', jobId: 'stop-job-1', provider: 'claude', model: 'claude-haiku-5-5',
    job: {requirements: {limits: {wall_seconds: 240}}, expires_at: null}, automatic: true, ownerAbsent: true});
  await history.flush();
  history.close();
  return out;
}

// The durable decision row, read back from the file the partition writes; a reopened partition must keep it too.
async function refusalRows(directory) {
  const file = join(directory, 'history', 'measurements', 'measurements.jsonl');
  const reread = async () => readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    .filter(row => row.type === 'admission_decided' && row.data.outcome === 'refused');
  const first = await reread();
  const reopened = createMeasurementHistory({directory: join(directory, 'history')});
  await reopened.flush();
  reopened.close();
  assert.deepEqual(await reread(), first, 'a reopened partition restores the refusal row unchanged');
  return first;
}

test('a stop measured over the bound is refused as stop_bound_unknown, and the saved decision names the check and its latency and bound', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stop-detail-over-'));
  try {
    const out = await refuseWithStop(directory, {delivered: true, fallback: null, latency_ms: 90000, removed: true});
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'stop_bound_unknown', 'the public reason code is unchanged');
    const [row] = await refusalRows(directory);
    assert.ok(row, 'the refusal is saved');
    assert.equal(row.data.reason, 'stop_bound_unknown');
    assert.deepEqual(row.data.refusal_detail, {stop_reason: 'stop_latency_over_bound', delivered: true, fallback: null,
      latency_ms: 90000, bound_ms: BOUND_MS, removed: true});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a stop that fell back to the hard stop is refused as stop_bound_unknown, and the saved decision keeps the fallback', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stop-detail-fallback-'));
  try {
    const out = await refuseWithStop(directory, {delivered: false, fallback: 'hard', latency_ms: 890, removed: true});
    assert.equal(out.reason, 'stop_bound_unknown');
    const [row] = await refusalRows(directory);
    assert.equal(row.data.refusal_detail.stop_reason, 'stop_not_delivered');
    assert.equal(row.data.refusal_detail.fallback, 'hard');
    assert.equal(row.data.refusal_detail.delivered, false);
    assert.equal(row.data.refusal_detail.latency_ms, 890);
    assert.equal(row.data.refusal_detail.bound_ms, BOUND_MS);
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a job-less preflight refused by the stop proof keeps the failed check in its saved decision and its gate row', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stop-detail-preflight-'));
  try {
    const history = createMeasurementHistory({directory: join(directory, 'history')});
    const {candidate} = createPace50Candidate({directory, now: () => T, account: H.account,
      account_week_id: `${H.account}:weekly:${WEEK}`, contextFor: () => ({plan: 'max20'}),
      source: runSource({delivered: true, fallback: null, latency_ms: 90000, removed: true}),
      ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 4})}, measurementHistory: history});
    const code = await candidate.preflight({provider: 'claude', ownerAbsent: true});
    await history.flush();
    history.close();
    assert.equal(code, 'stop_bound_unknown', 'the public reason code is unchanged');
    const decision = candidate.lastJobDecisionFor('claude');
    assert.equal(decision.reason, 'stop_bound_unknown');
    assert.equal(decision.detail?.stopReason, 'stop_latency_over_bound', 'the saved decision names the failed check');
    const file = join(directory, 'history', 'measurements', 'measurements.jsonl');
    const rows = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(row => row.type === 'admission_gate_refused');
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].data.refusal_detail, {stop_reason: 'stop_latency_over_bound', delivered: true, fallback: null,
      latency_ms: 90000, bound_ms: BOUND_MS, removed: true});
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});

test('a stop fact from another run is kept as its own sub-reason in a saved gate row', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'stop-detail-unobserved-'));
  try {
    const history = createMeasurementHistory({directory: join(directory, 'history')});
    history.record('admission_gate_refused', {outcome: 'held', provider: 'codex', reason: 'stop_bound_unknown',
      policy_reason: 'stop_bound_unknown', refusal_detail: {stopReason: 'stop_unobserved'}});
    await history.flush();
    history.close();
    const file = join(directory, 'history', 'measurements', 'measurements.jsonl');
    const [row] = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line))
      .filter(entry => entry.type === 'admission_gate_refused');
    assert.equal(row.data.refusal_detail?.stop_reason, 'stop_unobserved');
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
});
