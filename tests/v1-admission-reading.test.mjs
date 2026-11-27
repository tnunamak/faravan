import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../lib/v1/lender-pace50.mjs';
import {createOwnerSettings} from '../lib/v1/owner-settings.mjs';
import {createSyntheticPace50Source} from './helpers/pace50-synthetic-source.mjs';

// One admission reads the provider once. The gate and the reserve of an admission share that read, so a second and third read
// do not follow the first in a burst, which the provider's usage endpoint rate-limits (HTTP 429). A refusal names the sanitized HTTP
// class and failure reason of the read it was based on. The shared read lasts 30 s, which is inside the policy's 60 s freshness limit, and any
// job that starts, ends or is released drops it, so no decision after a spend reads a reading taken before the spend.
const ACCOUNT = 'synthetic-account';
const WEEK = 'synthetic-week-1';
const HAIKU = 'claude-haiku-5-5';
const T0 = Date.parse('2026-10-23T06:40:00Z');
const job = {requirements: {limits: {wall_seconds: 300}}, expires_at: null, budget_v1: {max_list_usd: 4}};
const gate = (pace) => pace.gate({provider: 'claude', model: HAIKU, jobId: 'job-1', job,
  automatic: true, ownerAbsent: true});
const reserve = (pace, attemptId = 'attempt-1', jobId = 'job-1') => pace.reserve({attemptId, jobId, provider: 'claude', model: HAIKU,
  job, automatic: true, ownerAbsent: true});

function fixture(t, {override = null, kappa = null} = {}) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'admission-reading-'));
  t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
  const clock = {now: T0};
  const ownerSettings = createOwnerSettings({directory: join(dir, 'owner-settings')});
  ownerSettings.set({by: 'owner', reason: 'test limit', now: T0, maxJobUsd: 1.5});
  const inner = createSyntheticPace50Source({start: T0, override, ...(kappa ? {kappa} : {})});
  const buildObjective = inner.objectiveInputFor.bind(inner);
  inner.objectiveInputFor = args => {
    const input = buildObjective(args);
    input.job.chunkCandidates = [{id: 'owner-capped-checkpoint', usdMicro: 1_500_000, friendValue: 100}];
    return input;
  };
  let reads = 0;
  const source = {...inner, observe: async (args) => { reads += 1; return inner.observe(args); }};
  const {candidate, adapter} = createPace50Candidate({directory: dir, now: () => clock.now, account: ACCOUNT,
    account_week_id: WEEK, source, ownerSettings,
    contextFor: () => ({consent: true, people: true, agents: true, schedule: true, unexpired: true, plan: 'max20'})});
  return {candidate, adapter, clock, reads: () => reads};
}

test('one admission reads the provider once: the gate and the reserve share that read', {timeout: 30000}, async (t) => {
  const f = fixture(t);
  assert.equal(await gate(f.candidate), null, 'the synthetic reading admits');
  const grant = await reserve(f.candidate);
  assert.equal(grant.ok, true, JSON.stringify(grant));
  assert.equal(f.reads(), 1, 'the gate and the reserve used one read between them');
  await f.adapter.close();
});

test('after an admission, the next gate reads the provider again, because the admission changed the account', {timeout: 30000}, async (t) => {
  const f = fixture(t);
  await gate(f.candidate);
  await reserve(f.candidate);
  assert.equal(f.reads(), 1);
  await gate(f.candidate);
  assert.equal(f.reads(), 2, 'the read taken before the admission is not reused after it');
  await f.adapter.close();
});

test('a reading older than the admission window is not reused', {timeout: 30000}, async (t) => {
  const f = fixture(t);
  await gate(f.candidate);
  f.clock.now += 31000;
  await gate(f.candidate);
  assert.equal(f.reads(), 2, 'a read 31 s old is read again');
  await f.adapter.close();
});

test('a job that is released drops the shared read, so the next gate reads again', {timeout: 30000}, async (t) => {
  const f = fixture(t);
  await gate(f.candidate);
  await f.candidate.release('attempt-not-started', {reason: 'test', prepared: false});
  await gate(f.candidate);
  assert.equal(f.reads(), 2, 'a release is a change to the account, so the read before it is not reused');
  await f.adapter.close();
});

test('a refused reserve names the sanitized reason and HTTP class of its reading', {timeout: 30000}, async (t) => {
  const probe = {reason: 'rate_limited', status_class: '4xx', usage_status: 429, identity_status: 429,
    usage_attempts: 3, identity_attempts: 1, body: 'must not cross the public boundary'};
  const f = fixture(t, {override: ({base}) => ({...base, identity: {verified: false, reason: 'identity_unobserved'}, probe})});
  const grant = await reserve(f.candidate);
  assert.equal(grant.ok, false, JSON.stringify(grant));
  assert.equal(grant.policyReason, 'identity_unknown');
  assert.deepEqual(grant.probe, {reason: 'rate_limited', status_class: '4xx'},
    'the refusal keeps the classified cause and excludes raw probe details');
  assert.equal(f.reads(), 1, 'the refusal used the one read, and did not read again');
  await f.adapter.close();
});

test('a finished job drops the shared read, so the next gate reads again', {timeout: 30000}, async (t) => {
  const f = fixture(t);
  await gate(f.candidate);
  // An execution with no result is settled as unknown usage: nothing is transitioned, and the shared read still has to go.
  await f.candidate.finish({attemptId: 'attempt-not-started', provider: 'claude', model: HAIKU, execution: {stdout: ''}});
  await gate(f.candidate);
  assert.equal(f.reads(), 2, 'a finish is a change to the account, so the read before it is not reused');
  await f.adapter.close();
});

test('a five-hour chunk that holds more than one point leaves the state readable, so the job can start', {timeout: 30000}, async (t) => {
  // The objective-sized chunk converts to more than one point in this window.
  // The state check must accept that hold or the job cannot start.
  const f = fixture(t, {kappa: {weekly: 50000, short: 1600000}});
  const grant = await reserve(f.candidate);
  assert.equal(grant.ok, true, JSON.stringify(grant));
  const short = f.adapter.state().attempts[0].resources.find((r) => r.kind === 'short');
  assert.ok(short.held_micro > 1000000, `the five-hour hold is above one point: ${short.held_micro}`);
  await f.adapter.close();
});
