import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {agentModelMatches, cumulativeProviderGate, compareSpendLedger, installedDataHome, desktopLauncher, judgeNothingRunning, pointsFor, readPace50Attempts, sumPointsAsUsdMicro} from '../packaging/journey/evidence.mjs';

test('cumulative provider deltas share one conversion basis and enforce the run cap', () => {
  const rows = [{id: 'claude', instance: 'account-a', kappaMicro: 1_000_000, meterDeltaMicro: 1_200_000, observedAt: Date.now()}];
  const gate = cumulativeProviderGate([{label: 'job 1', rows}, {label: 'job 2', rows}], 2_000_000);
  assert.equal(gate.pass, false);
  assert.match(gate.breaches.join(' '), /cumulative provider charge 2400000 USD micro/);
});

test('resource deltas with different kappas convert to USD micro before the total is compared', () => {
  const observedAt = Date.now();
  const gate = cumulativeProviderGate([{label: 'job 1', rows: [
    {id: 'weekly', instance: 'a', kappaMicro: 1_000_000, meterDeltaMicro: 1_200_000, observedAt},
    {id: 'short', instance: 'a', kappaMicro: 100_000, meterDeltaMicro: 120_000, observedAt},
  ]}], 2_000_000);
  assert.equal(gate.totalUsdMicro, 2_400_000);
  assert.equal(gate.pass, false);
});

test('app spend totals convert each resource with its own kappa and reject missing counters', () => {
  const rows = [{id: 'weekly', kappaMicro: 1_000_000, spentMicro: 1_200_000},
    {id: 'short', kappaMicro: 100_000, spentMicro: 120_000}];
  assert.equal(sumPointsAsUsdMicro(rows, 'spentMicro').usdMicro, 2_400_000);
  assert.ok(sumPointsAsUsdMicro([{...rows[0], spentMicro: undefined}], 'spentMicro').missing.length > 0);
});

test('missing or malformed provider accounting fails closed while fresh zero movement passes', () => {
  assert.equal(cumulativeProviderGate([], 2_000_000).pass, false);
  assert.equal(cumulativeProviderGate([{label: 'job 1', rows: []}], 2_000_000).pass, false);
  assert.equal(cumulativeProviderGate([{label: 'job 1', rows: [], missing: ['attempt.resources']}], 2_000_000).pass, false);
  assert.equal(cumulativeProviderGate([{label: 'job 1', rows: [{id: 'claude', kappaMicro: 1_000_000, meterDeltaMicro: -1, observedAt: Date.now()}]}], 2_000_000).pass, false);
  assert.equal(cumulativeProviderGate([{label: 'job 1', rows: [{id: 'claude', kappaMicro: 1_000_000, meterDeltaMicro: 0, observedAt: Date.now()}]}], 2_000_000).pass, true);
  assert.equal(cumulativeProviderGate([{label: 'job 1', rows: [{id: 'claude', kappaMicro: 1_000_000, meterDeltaMicro: 0, observedAt: 1}]}], 2_000_000).pass, false);
});

test('attempt accounting requires complete fresh counters but permits zero provider movement', () => {
  const resource = {id: 'claude', kappa_micro: 1_000_000, spent_micro: 0, initial_micro: 2_000_000,
    baseline_used_micro: 10, aggregate_used_micro: 10, aggregate_observed_at: Date.now()};
  assert.deepEqual(pointsFor({resources: [resource]}, 1_500_000).missing, []);
  assert.ok(pointsFor({resources: [{...resource, aggregate_observed_at: undefined}]}, 1_500_000).missing.length > 0);
  assert.ok(pointsFor({resources: [{...resource, spent_micro: 2_000_001}]}, 1_500_000).missing.length > 0);
});

test('pace50 accounting reads every execution attempt for a job', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-accounting-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  fs.mkdirSync(path.join(home, 'v1'));
  fs.writeFileSync(path.join(home, 'v1', 'lending-pace50-state.json'), JSON.stringify({attempts: [
    {id: 'a1', job_id: 'digest'}, {id: 'a2', job_id: 'digest'}, {id: 'other', job_id: 'other'},
  ]}));
  assert.deepEqual(readPace50Attempts(home, 'digest').attempts.map(attempt => attempt.id), ['a1', 'a2']);
});

test('malformed pace50 attempts and resources are named as missing evidence', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-accounting-malformed-'));
  t.after(() => fs.rmSync(home, {recursive: true, force: true}));
  fs.mkdirSync(path.join(home, 'v1'));
  fs.writeFileSync(path.join(home, 'v1', 'lending-pace50-state.json'), JSON.stringify({attempts: [null]}));
  const read = readPace50Attempts(home, 'digest');
  assert.equal(read.attempts.length, 0);
  assert.ok(read.missing.some(item => item.includes('attempts[0] malformed')));
  assert.ok(pointsFor(null, 1_500_000).missing.length > 0);
  assert.ok(pointsFor({resources: [null]}, 1_500_000).missing.length > 0);
});

test('nothing-running verdict fails closed on missing and conflicting evidence', () => {
  const base = {attemptState: 'completed', lendingCurrent: null, attemptId: 'attempt-1', appProof: false, runsUnchanged: true, live: false};
  const unknownScan = judgeNothingRunning({...base, scan: {pids: null}});
  assert.equal(unknownScan.pass, null);
  assert.ok(unknownScan.missing.length > 0);
  assert.equal(judgeNothingRunning({...base, appProof: true, scan: {pids: [101]}}).pass, false);
  assert.equal(judgeNothingRunning({...base, scan: {pids: []}}).pass, true);
  assert.equal(judgeNothingRunning({...base, attemptState: 'running', scan: {pids: []}}).pass, false);
  assert.equal(judgeNothingRunning({...base, lendingCurrent: 'attempt-1', scan: {pids: []}}).pass, false);
  assert.equal(judgeNothingRunning({...base, runsUnchanged: false, scan: {pids: []}}).pass, false);
});

test('persisted Claude model checks reject changes after an earlier correct readback', () => {
  const initial = [{id: 'claude-code-subscription', run: {model: 'claude-haiku-5-5'}}];
  const changedLater = [{id: 'claude-code-subscription', run: {model: 'wrong-after-limits-save'}}];
  const missingAfterRestart = [{id: 'claude-code-subscription', run: {model: null}}];
  assert.equal(agentModelMatches(initial, 'claude-code-subscription', 'claude-haiku-5-5'), true);
  assert.equal(agentModelMatches(changedLater, 'claude-code-subscription', 'claude-haiku-5-5'), false);
  assert.equal(agentModelMatches(missingAfterRestart, 'claude-code-subscription', 'claude-haiku-5-5'), false);
  assert.equal(agentModelMatches([], 'claude-code-subscription', 'claude-haiku-5-5'), false);
});

test('spend ledger comparison ignores mutable metadata but requires accounting counters', () => {
  const before = {jobs: [{digest: 'd1', state: 'done'}], spend: [{digest: 'd1', attemptId: 'a1', resource: 'claude', kappaMicro: 1, baselineMicro: 2, aggregateMicro: 3, spentMicro: 1, reservedMicro: 5, observedAt: 'old'}]};
  const after = structuredClone(before);
  after.spend[0].observedAt = 'new';
  assert.equal(compareSpendLedger(before, after), true);
  assert.equal(compareSpendLedger(before, {jobs: before.jobs}), false);
});

test('installed launcher and channel identity name the normal app and its shared data home', () => {
  assert.deepEqual(desktopLauncher('[Desktop Entry]\nExec=/home/user/.local/bin/faravan\n'),
    {binary: '/home/user/.local/bin/faravan', args: []});
  assert.equal(desktopLauncher('[Desktop Entry]\nExec=faravan\n'), null);
  assert.equal(installedDataHome('channel=faravan\ndata_home=/home/user/.faravan\n'), '/home/user/.faravan');
  assert.equal(installedDataHome('channel=faravan\n'), null);
});
