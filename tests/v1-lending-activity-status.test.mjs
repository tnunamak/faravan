import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLendingRuntime} from '../lib/v1/lending-runtime.mjs';
import {LINES} from '../lib/v1/lending-status-copy.mjs';

// Present-tense lending comes from the active lifecycle, not from the last quote. The candidate's cached quote and its
// reserve, finish and release are stubbed, so the status is derived from exactly what the runtime tracks. No provider calls.
const T0 = Date.parse('2026-10-23T06:40:00Z');
const ADMITTED = {admitted: true, reason: 'objective_lend', objective: {admission: 'allowed', reasonCode: 'objective_lend',
  reasonText: 'Lending 1 point after protecting expected use.', protectionSource: 'weekly_upper_band', nativeMaxBudgetUsd: 1}};

function runtimeFixture(t) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'activity-status-'));
  t.after(() => fs.rmSync(directory, {recursive: true, force: true}));
  const runtime = createLendingRuntime({directory, backend: {}, now: () => T0, presence: () => false,
    settings: () => ({enabled: true, intent: 'on', activeCircle: 'circle', modes: {circle: 'auto'}, limits: {lendingPolicy: {protectionPosition: 'balanced',
      providerConsent: {claude: true}, accountPlans: {claude: 'max20'}}}}),
    pace50: {account: 'synthetic-account', account_week_id: 'synthetic-week-1'}});
  let current = ADMITTED;
  const lastJob = {...ADMITTED, admitted: true, reason: 'last_job_admitted'};
  runtime.candidate.projectStatus = async () => current;
  runtime.candidate.lastJobDecisionFor = provider => provider === 'claude' ? lastJob : null;
  // A last job result remains available, but current status comes from projectStatus.
  runtime.candidate.decisionFor = provider => (provider === 'claude' ? ADMITTED : undefined);
  runtime.candidate.reserve = async args => ({ok: true, attemptId: args.attemptId});
  runtime.candidate.finish = async () => ({applied: true});
  return {runtime, setProjection: value => { current = value; }, lastJob};
}
const claudeStatus = async runtime => (await runtime.view()).accounts.find(account => account.id === 'claude').decision.status;
const args = {attemptId: 'attempt-1', jobId: 'job-1', provider: 'claude', model: 'claude-haiku-5-5'};

test('a quote with nothing reserved reads as ready, never as lending now', {timeout: 60000}, async t => {
  const {runtime} = runtimeFixture(t);
  assert.equal(runtime.busy('claude'), false, 'nothing is reserved');
  const status = await claudeStatus(runtime);
  assert.equal(status.id, 'ready');
  assert.equal(status.line, LINES.ready);
  assert.notEqual(status.line, LINES.lend);
});

test('a finished job no longer reads as lending now, until another job is reserved', {timeout: 60000}, async t => {
  const {runtime} = runtimeFixture(t);
  const grant = await runtime.reserve(args);
  assert.equal(grant.ok, true, 'the reservation is granted');
  assert.equal(runtime.busy('claude'), true, 'the reservation is active');
  assert.equal((await claudeStatus(runtime)).line, LINES.lend, 'while the reservation is active, lending is present tense');
  await runtime.finish({attemptId: 'attempt-1', provider: 'claude', model: 'claude-haiku-5-5', execution: {stdout: ''}});
  assert.equal(runtime.busy('claude'), false, 'the finished job holds nothing');
  const after = await claudeStatus(runtime);
  assert.equal(after.line, LINES.ready, 'the finished job is not lending now, though the last quote is still an admission');
  assert.notEqual(after.line, LINES.lend);
});

test('fresh status replaces the last job hold on admit, hold and recovery transitions', {timeout: 60000}, async t => {
  const {runtime, setProjection, lastJob} = runtimeFixture(t);
  const admitted = (await runtime.view()).accounts.find(account => account.id === 'claude').decision;
  assert.equal(admitted.availability.admitted, true);
  assert.equal(admitted.status.line, LINES.ready);

  setProjection({admitted: false, reason: 'owner_settings_unreadable', objective: {
    admission: 'held', reasonCode: 'owner_settings_unreadable', reasonText: 'Holding because owner settings are unreadable.'}});
  const held = (await runtime.view()).accounts.find(account => account.id === 'claude').decision;
  assert.equal(held.admitted, false, 'fresh hold controls the current headline');
  assert.equal(held.reason, 'owner_settings_unreadable');
  assert.equal(held.objective.reasonText, LINES.owner_settings, 'the explanation uses the same fresh hold');
  assert.equal(held.status.line, LINES.owner_settings);
  assert.equal(held.availability.status.line, LINES.owner_settings, 'quota fallback receives the same status');
  assert.deepEqual(held.lastJobDecision, lastJob, 'the last job result remains separate and unchanged');

  setProjection({admitted: true, reason: 'objective_lend', objective: {
    admission: 'allowed', reasonCode: 'objective_lend', reasonText: 'Lending 1 point after protecting expected use.',
    protectionSource: 'weekly_upper_band', lendablePoints: {seven_day: 12.5}}});
  const recovered = (await runtime.view()).accounts.find(account => account.id === 'claude').decision;
  assert.equal(recovered.admitted, true, 'fresh recovery replaces the prior hold');
  assert.equal(recovered.status.line, LINES.ready);
  assert.equal(recovered.availability.status.line, LINES.ready);
  assert.deepEqual(recovered.lastJobDecision, lastJob, 'recovery does not rewrite the last job result');
});
