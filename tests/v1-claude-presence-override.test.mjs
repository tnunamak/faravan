import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as overrideModule from '../lib/v1/presence-override.mjs';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import * as realSource from './helpers/real-source.mjs';
import {withOwnMeasurement} from './helpers/own-measurement.mjs';
const source = withOwnMeasurement(realSource);
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';
// The real meter/conversion remains under test; only objective demand evidence is synthetic.
const objectiveInputFor = createSyntheticPace50Source().objectiveInputFor;

const NOW = Date.parse('2026-10-23T06:40:00Z');
const MIN = 60000;
const fresh = () => mkdtempSync(join(tmpdir(), 'presence-override-'));
const request = (store, extra = {}) => store.request({jobId: 'job-test-1', by: 'owner (relayed by lead)',
  reason: 'run this artifact job now', now: NOW, ttlMs: 15 * MIN, ...extra});

test('an owner override names one job, is consumed once, and reads as nothing afterwards', () => {
  const dir = fresh();
  try {
    const store = overrideModule.createPresenceOverrideStore({directory: dir});
    request(store);
    assert.deepEqual(store.consume({jobId: 'job-test-1', now: NOW + MIN}), {granted: true});
    assert.deepEqual(store.consume({jobId: 'job-test-1', now: NOW + 2 * MIN}), {granted: false, reason: 'already_consumed'});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an override for one job never grants another, and no request means no grant', () => {
  const dir = fresh();
  try {
    const store = overrideModule.createPresenceOverrideStore({directory: dir});
    assert.deepEqual(store.consume({jobId: 'job-test-1', now: NOW}), {granted: false, reason: 'no_override'}, 'never a default');
    request(store);
    assert.deepEqual(store.consume({jobId: 'job-other', now: NOW}), {granted: false, reason: 'no_override'});
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an override expires, and a bound on its lifetime is enforced at the request', () => {
  const dir = fresh();
  try {
    const store = overrideModule.createPresenceOverrideStore({directory: dir});
    request(store);
    assert.deepEqual(store.consume({jobId: 'job-test-1', now: NOW + 16 * MIN}), {granted: false, reason: 'expired'});
    assert.throws(() => request(store, {jobId: 'job-long', ttlMs: 61 * MIN}), /invalid_presence_override/, 'longer than the bound');
    assert.throws(() => request(store, {jobId: 'job-no-ttl', ttlMs: undefined}), /invalid_presence_override/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('every request and every grant is audited with who, why, which job, and when', () => {
  const dir = fresh();
  try {
    const store = overrideModule.createPresenceOverrideStore({directory: dir});
    request(store);
    store.consume({jobId: 'job-test-1', now: NOW + MIN});
    const audit = store.audit();
    assert.deepEqual(audit.map((entry) => entry.event), ['requested', 'consumed']);
    assert.equal(audit[0].by, 'owner (relayed by lead)');
    assert.equal(audit[0].job_id, 'job-test-1');
    assert.equal(audit[1].at, NOW + MIN);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

test('an observed-present owner is refused as readiness_changed, and one granted override admits exactly that gate', async () => {
  const dir = fresh();
  try {
    const store = overrideModule.createPresenceOverrideStore({directory: dir});
    const accountWeek = 'f12e3786d2837824:weekly:1793325600000';
    const admissible = source.createRealPace50Source({
      readings: async () => ({windows: [
        {window_id: 'seven_day', window_minutes: 10080, used_pct: 5, resets_at: 1793325600000, observed_at: NOW, state: 'open'},
        {window_id: 'five_hour', window_minutes: 300, used_pct: 24, resets_at: 1792744800000, observed_at: NOW, state: 'open'},
      ]}),
      funding: async () => ({extra_usage: 'disabled', observed_at: NOW, guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'},
        identity: {account_sha256_16: 'f12e3786d2837824', email_sha256_16: 'aaaa0000bbbb1111', org_sha256_16: '5555666677778888'},
        executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2'}, stop: {delivered: true, fallback: null, latency_ms: 700, removed: true}}),
      expectedIdentity: async () => ({email_sha256_16: 'aaaa0000bbbb1111'}),
      expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true}, stopBoundMs: 30000,
      windowOrigin: async () => new Map([['five_hour', 'owner'], ['seven_day', 'owner']]),
    });
    const {candidate} = createPace50Candidate({objectiveInputFor, contextFor: () => ({plan: 'max20'}), directory: join(dir, 'pace50'), now: () => NOW, account: 'f12e3786d2837824',
      account_week_id: accountWeek, source: admissible, ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 1.5})}});
    const job = {requirements: {limits: {wall_seconds: 240}}, expires_at: null, budget_v1: {max_list_usd: 1.5}};
    const reserve = (ownerAbsent) => candidate.reserve({attemptId: `attempt-${ownerAbsent}`, jobId: 'job-test-1', provider: 'claude',
      model: 'claude-haiku-5-5', job, automatic: true, ownerAbsent});
    const present = await reserve(false);
    assert.equal(present.ok, false);
    assert.equal(present.reason, 'readiness_changed', 'the presence gate refuses an active owner');
    assert.equal(present.policyReason, 'controls');
    // The granted override moves only the presence gate for its one job.
    store.request({jobId: 'job-test-1', by: 'owner (relayed by lead)', reason: 'run now', now: NOW, ttlMs: 15 * MIN});
    const granted = store.consume({jobId: 'job-test-1', now: NOW});
    assert.equal(granted.granted, true);
    const admitted = await reserve(granted.granted);
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});

// The production candidate reads the owner's one-job override itself, when it admits a job. Nothing here consumes the override by
// hand or passes the owner as absent: an active owner is refused until an override names the job, the override is spent only by an
// admission that succeeds, and a refusal for any other reason leaves it unspent.
function presenceCandidate(directory, presenceOverrides) {
  const admissible = source.createRealPace50Source({
    readings: async () => ({windows: [
      {window_id: 'seven_day', window_minutes: 10080, used_pct: 5, resets_at: 1793325600000, observed_at: NOW, state: 'open'},
      {window_id: 'five_hour', window_minutes: 300, used_pct: 24, resets_at: 1792744800000, observed_at: NOW, state: 'open'},
    ]}),
    funding: async () => ({extra_usage: 'disabled', observed_at: NOW, guest_auth: {loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty'},
      identity: {account_sha256_16: 'f12e3786d2837824', email_sha256_16: 'aaaa0000bbbb1111', org_sha256_16: '5555666677778888'},
      executor: {backend_id: 'docker-sbx', sbx_version: 'sbx version v0.49.2'}, stop: {delivered: true, fallback: null, latency_ms: 700, removed: true}}),
    expectedIdentity: async () => ({email_sha256_16: 'aaaa0000bbbb1111'}),
    expectedExecutor: {backend_id: 'docker-sbx', accepts: () => true}, stopBoundMs: 30000,
    windowOrigin: async () => new Map([['five_hour', 'owner'], ['seven_day', 'owner']]),
  });
  return createPace50Candidate({objectiveInputFor, contextFor: () => ({plan: 'max20'}), directory, now: () => NOW, account: 'f12e3786d2837824',
    account_week_id: 'f12e3786d2837824:weekly:1793325600000', source: admissible, ownerSettings: {limit: () => ({state: 'set', maxJobUsd: 1.5})},
    presenceOverrides});
}

test('the production candidate admits an active owner\'s job only once an override names it, and records the spend', {timeout: 30000}, async () => {
  const dir = fresh();
  try {
    const store = overrideModule.createPresenceOverrideStore({directory: join(dir, 'presence')});
    const {candidate, adapter} = presenceCandidate(join(dir, 'pace50'), store);
    const reserve = (jobId, extra = {}) => candidate.reserve({attemptId: `attempt-${jobId}-${Math.random()}`, jobId, provider: 'claude',
      model: 'claude-haiku-5-5', job: {requirements: {limits: {wall_seconds: 240}}, expires_at: null, budget_v1: {max_list_usd: 1.5}}, automatic: true, ownerAbsent: false,
      ...extra});
    const refused = await reserve('job-test-1');
    assert.equal(refused.reason, 'readiness_changed', 'an active owner and no override');
    store.request({jobId: 'job-test-1', by: 'owner (relayed by lead)', reason: 'run now', now: NOW, ttlMs: 15 * MIN});
    assert.equal((await reserve('job-other')).reason, 'readiness_changed', 'an override names one job');
    const paused = await reserve('job-test-1', {paused: true});
    assert.equal(paused.ok, false, 'refused for another reason');
    assert.equal(store.available({jobId: 'job-test-1', now: NOW}).granted, true, 'a refused admission does not spend the override');
    const admitted = await reserve('job-test-1');
    assert.equal(admitted.ok, true, JSON.stringify(admitted));
    assert.equal(store.available({jobId: 'job-test-1', now: NOW}).reason, 'already_consumed', 'the admission spent the override once');
    assert.deepEqual(store.audit().map((entry) => entry.event), ['requested', 'consumed']);
    await adapter.close();
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
