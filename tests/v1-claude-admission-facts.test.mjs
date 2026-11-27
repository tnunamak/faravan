import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as realSource from '../lib/v1/lending-pace50-source.mjs';
import {withOwnMeasurement} from './helpers/own-measurement.mjs';
const source = withOwnMeasurement(realSource);
import { createPace50Candidate } from '../lib/v1/lender-pace50.mjs';

const T = Date.parse('2026-10-23T06:00:00Z');
// Fixture values are hashes and readings, the only forms that reach admission. None is an account identifier.
const H = { account: '1111222233334444', email: 'aaaa0000bbbb1111', org: '5555666677778888' };
const FIVE = Date.parse('2026-10-23T08:40:00Z');
const WEEK = Date.parse('2026-10-30T02:00:00Z');
const CLAUDE_AUTH = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' };
const IDENTITY = { account_sha256_16: H.account, email_sha256_16: H.email, org_sha256_16: H.org };
const windows = [
  { window_id: 'seven_day', window_minutes: 10080, used_pct: 4, resets_at: WEEK, observed_at: T, state: 'open' },
  { window_id: 'five_hour', window_minutes: 300, used_pct: 16, resets_at: FIVE, observed_at: T, state: 'open' },
];
// Stand-in for the product's version floor (0.42.0 is the security minimum in sbxVersionCheck).
const EXPECTED_EXECUTOR = { backend_id: 'docker-sbx', accepts: (version) => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(version);
  return Boolean(match) && (Number(match[1]) > 0 || Number(match[2]) >= 42);
} };
const EXECUTOR = { backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2 5d40fd43027b33ed1f1a39c14fb07e2503d6998f' };
const STOP = { delivered: true, fallback: null, latency_ms: 890, removed: true };
const runSource = (overrides = {}, rest = {}) => source.createRealPace50Source({
  readings: async () => ({ windows }),
  // Executor and stop are the machine's receipt, not part of an account's reading; an override of either edits the receipt.
  funding: async () => { const {executor, stop, ...fact} = overrides;
    return { extra_usage: 'disabled', observed_at: T, guest_auth: CLAUDE_AUTH, identity: IDENTITY, ...fact }; },
  stopEvidence: async () => ({ executor: 'executor' in overrides ? overrides.executor : EXECUTOR,
    stop: 'stop' in overrides ? overrides.stop : STOP, measured_at: T }),
  expectedIdentity: async () => ({ email_sha256_16: H.email }),
  expectedExecutor: EXPECTED_EXECUTOR, stopBoundMs: 30000, ...rest,
});

test('a reset instant that jitters below a second names the same window instance, so one window is not read as two', () => {
  // The provider's reset instant moved by 380 ms between two probes of one window (see the probe evidence).
  const first = source.resourcesFromReadings([{ ...windows[1], resets_at: FIVE + 58 }]).resources[0];
  const second = source.resourcesFromReadings([{ ...windows[1], resets_at: FIVE + 438 }]).resources[0];
  assert.equal(first.instance, second.instance);
  assert.equal(first.instance, `five_hour@${FIVE}`);
});

test('the account week and epoch come from the weekly window observed in the same run; a reset changes the epoch', () => {
  const resources = source.resourcesFromReadings(windows).resources;
  const verified = { verified: true, account_id: H.account };
  assert.deepEqual(source.weeklyWindowIdentity({ resources, identity: verified }),
    { account_week_id: `${H.account}:weekly:${WEEK}`, epoch: `seven_day@${WEEK}` });
  const afterReset = source.resourcesFromReadings(windows.map((w) => (w.window_id === 'seven_day' ? { ...w, resets_at: WEEK + 604800000 } : w))).resources;
  assert.notEqual(source.weeklyWindowIdentity({ resources: afterReset, identity: verified }).epoch, `seven_day@${WEEK}`, 'a reset changes the epoch');
  assert.deepEqual(source.weeklyWindowIdentity({ resources, identity: { verified: false, reason: 'identity_mismatch' } }), { account_week_id: null, epoch: null });
  assert.deepEqual(source.weeklyWindowIdentity({ resources: resources.filter((r) => r.kind !== 'weekly'), identity: verified }), { account_week_id: null, epoch: null });
});

test('the executor is proven only when the sbx backend that ran the probe is the expected one at an accepted version', () => {
  assert.deepEqual(source.executorProof(EXECUTOR, EXPECTED_EXECUTOR), { single_executor: 'proven', reason: null });
  assert.equal(source.executorProof(null, EXPECTED_EXECUTOR).single_executor, 'unknown', 'no observation is not an executor');
  assert.equal(source.executorProof({ ...EXECUTOR, backend_id: 'other-backend' }, EXPECTED_EXECUTOR).single_executor, 'unknown');
  assert.equal(source.executorProof({ ...EXECUTOR, sbx_version: 'sbx version v0.41.0' }, EXPECTED_EXECUTOR).single_executor, 'unknown');
  assert.equal(source.executorProof({ ...EXECUTOR, sbx_version: undefined }, EXPECTED_EXECUTOR).single_executor, 'unknown');
  assert.equal(source.executorProof(EXECUTOR, null).single_executor, 'unknown', 'an unconfigured expectation proves nothing');
});

test('the stop bound is proven only by a delivered guard receipt inside the configured bound, with host removal', () => {
  assert.deepEqual(source.stopProof(STOP, 30000, 30000), { bounded_execution: 'proven', reason: null, uncertainty_ms: 0 });
  assert.equal(source.stopProof(null, 30000, 30000).bounded_execution, 'unknown', 'no measured receipt');
  assert.equal(source.stopProof({ ...STOP, delivered: false, fallback: 'hard' }, 30000, 30000).bounded_execution, 'unknown');
  assert.equal(source.stopProof({ ...STOP, latency_ms: 30001 }, 30000, 30000).bounded_execution, 'unknown', 'slower than the bound');
  assert.equal(source.stopProof({ ...STOP, removed: false }, 30000, 30000).bounded_execution, 'unknown', 'a receipt alone does not end a descendant');
  assert.equal(source.stopProof(STOP, null, 30000).bounded_execution, 'unknown', 'an unconfigured bound proves nothing');
});

test('with the five facts observed in one run, the pace input reaches the next unproven fact', async () => {
  const obs = await runSource().observe({ provider: 'claude', model: 'claude-haiku-5-5', plan: 'max20' });
  assert.equal(obs.account_week_id, `${H.account}:weekly:${WEEK}`);
  assert.equal(obs.epoch, `seven_day@${WEEK}`);
  assert.deepEqual(obs.executor, { single_executor: 'proven', reason: null });
  assert.deepEqual(obs.stop, { bounded_execution: 'proven', reason: null, proven_until: T + 86_400_000 });
  assert.ok(obs.resources.every((r) => Number.isSafeInteger(r.kappa_micro) && r.kappa_micro > 0));
  // Certified source facts map successfully; objective evidence is a separate candidate requirement.
  const input = source.paceInputFromObservation(obs, { now: T, context: {} });
  assert.equal(input.refuse, undefined);
  assert.equal(input.evidence.complete, true);
});

test('a fact that is missing, unmeasured or from another run keeps its own refusal', async () => {
  const refusal = async (src) => source.paceInputFromObservation(await src.observe({ provider: 'claude', model: 'claude-haiku-5-5', plan: 'max20' }), { now: T, context: {} }).refuse;
  assert.equal(await refusal(runSource({ executor: undefined })), 'executor_unknown');
  assert.equal(await refusal(runSource({ stop: undefined })), 'stop_bound_unknown');
  const unknown = await runSource().observe({provider: 'claude', model: 'unknown', plan: 'max20'});
  assert.equal(source.paceInputFromObservation(unknown, {now: T}).refuse, 'conversion_unknown');
  assert.equal(await refusal(runSource({ identity: undefined })), 'identity_unknown');
  // The stop receipt belongs to the machine, so a reading from an earlier run neither adds to it nor removes it.
  const earlier = await runSource({ observed_at: T - 60000 }).observe({ provider: 'claude', model: 'claude-haiku-5-5', plan: 'max20' });
  assert.equal(earlier.executor.single_executor, 'proven');
  assert.equal(earlier.stop.bounded_execution, 'proven');
});

test('no owner limit does not bypass missing objective evidence or record an attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rq-admission-unset-'));
  try {
    const { candidate } = createPace50Candidate({ directory, now: () => T, account: H.account,
      account_week_id: `${H.account}:weekly:${WEEK}`, contextFor: () => ({plan: 'max20'}), source: runSource() });
    const out = await candidate.reserve({ attemptId: 'rq-attempt-1', jobId: 'rq-job-1', provider: 'claude', model: 'claude-haiku-5-5',
      job: { requirements: { limits: { wall_seconds: 240 } }, expires_at: null }, automatic: true, ownerAbsent: true });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'objective_evidence_unknown');
    assert.equal(out.policyReason, 'objective_evidence_unknown', 'certified conversion does not invent trusted objective evidence');
    assert.equal(candidate.adapter.state().attempts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('through the real candidate, reserve declines missing objective evidence with the named reason and records no attempt', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rq-admission-'));
  try {
    const { candidate } = createPace50Candidate({ directory, now: () => T, account: H.account,
      account_week_id: `${H.account}:weekly:${WEEK}`, contextFor: () => ({plan: 'max20'}), source: runSource(), ownerSettings: { limit: () => ({state: 'set', maxJobUsd: 4}) } });
    const out = await candidate.reserve({ attemptId: 'rq-attempt-1', jobId: 'rq-job-1', provider: 'claude', model: 'claude-haiku-5-5',
      job: { requirements: { limits: { wall_seconds: 240 } }, expires_at: null }, automatic: true, ownerAbsent: true });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'objective_evidence_unknown');
    assert.equal(out.policyReason, 'objective_evidence_unknown');
    assert.equal(candidate.adapter.state().attempts.length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
