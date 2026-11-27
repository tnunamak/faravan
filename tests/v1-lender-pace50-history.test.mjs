import './helpers/no-browser.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {candidateBuildInput} from '../lib/v1/lender-pace50.mjs';

const M = 1_000_000;
const NOW = Date.UTC(2026, 9, 23, 12);
const WEEK = 7 * 24 * 60 * 60 * 1000;

function observation() {
  return {refresh_succeeded: true, complete: true, observed_at: NOW,
    identity: {verified: true, account_id: 'account-hash'}, account_week_id: 'week-4', epoch: 'current-epoch',
    weekly_resource_id: 'seven_day',
    funding: {subscription_only: 'proven'}, executor: {single_executor: 'proven'},
    stop: {bounded_execution: 'proven'}, stop_bound_ms: 60_000, uncertainty_ms: 0,
    resources: [
      {id: 'seven_day', kind: 'weekly', instance: 'week-4', state: 'open', anchor_at: NOW - WEEK,
        resets_at: NOW + WEEK, duration_ms: WEEK, observed_at: NOW, used_micro: 10 * M,
        kappa_micro: M, kappa_lower_micro: null, origin: 'owner'},
      {id: 'five_hour', kind: 'short', instance: 'short-4', state: 'open', anchor_at: NOW - 60_000,
        resets_at: NOW + 4 * 60 * 60_000, duration_ms: 5 * 60 * 60_000, observed_at: NOW, used_micro: 5 * M,
        kappa_micro: M, kappa_lower_micro: null, origin: 'owner'},
    ]};
}

test('candidate input consumes weeklyScores(resource) maps as one frozen joint whole-week band', async () => {
  const calls = [];
  const rows = new Map(Array.from({length: 3}, (_, index) => {
    const end = NOW - (3 - index) * WEEK;
    return [end, {epoch: end, start: end - WEEK, end, resource: 'resource', score: 10 + index,
      ownerUsagePct: 10 + index, complete: true, reason: null, source: 'meter'}];
  }));
  const history = {weeklyScores(resource) { calls.push(resource); return rows; }};
  const build = candidateBuildInput({source: {observe: async () => observation()}, history,
    objectiveInputFor: async ({band}) => ({band})});
  const result = await build({state: {account: 'local-owner', attempts: []}, request: {model: 'claude-haiku-5-5', plan: 'max20'},
    now: NOW, context: {provider: 'claude'}});

  assert.deepEqual(calls, ['seven_day', 'five_hour']);
  assert.equal(result.objective.band.weeks.length, 3);
  assert.equal(result.objective.band.epoch, 'm1-whole-week-owner-usage-v1/claude/max20');
  assert.equal(result.objective.band.procedure, 'joint-max-utilization/zero-forecast/scale-100-v1');
  assert.deepEqual(result.objective.band.domain, ['seven_day@decision', 'five_hour@decision']);
  assert.equal(result.objective.band.weeks[0].upperScores['seven_day@decision'], 0.1);
  assert.equal(result.objective.band.weeks[2].upperScores['five_hour@decision'], 0.12);
  assert.equal(result.account, 'local-owner', 'provider hash is checked but durable history stays device-scoped');
  assert.ok(result.windows.every(window => window.account === 'local-owner'),
    'the policy resource vector must use the same device-scoped account as the durable candidate');
});

test('missing or unreadable week history falls through to fresh pace evidence', async () => {
  const source = {observe: async () => {
    const result = observation();
    result.resources[0].pace_rate_micro_per_hour = 100_000;
    result.resources[1].pace_rate_micro_per_hour = 200_000;
    return result;
  }};
  const built = candidateBuildInput({source, history: {weeklyScores() { throw new Error('history file unavailable'); }},
    objectiveInputFor: async ({band, input}) => ({band, pace: input.windows.map(window => window.pace_rate_micro_per_hour)})});
  const result = await built({state: {account: 'local-owner', attempts: []}, request: {model: 'claude-haiku-5-5', plan: 'max20'},
    now: NOW, context: {provider: 'claude'}});

  assert.equal(result.refuse, undefined);
  assert.deepEqual(result.objective.band.weeks, []);
  assert.deepEqual(result.objective.pace, [100_000, 200_000]);
});

test('a scoped key selects the weekly history of its own account; the bare provider keeps the provider\'s', async () => {
  const OTHER = 'claude:12345678-1234-4123-8123-123456789abc';
  const calls = [];
  // Each history callback answers with a different row set, and records the key it was asked for.
  const history = key => ({weeklyScores(resource) {
    calls.push([key, resource]);
    const score = key === OTHER ? 0.9 : 0.1;
    return new Map([[NOW - WEEK, {epoch: NOW - WEEK, start: NOW - 2 * WEEK, end: NOW - WEEK, resource, score,
      ownerUsagePct: score * 100, complete: true, reason: null, source: 'meter'}]]);
  }});
  const build = candidateBuildInput({source: {observe: async () => observation()}, history,
    objectiveInputFor: async ({band}) => ({band})});
  const state = {account: 'local-owner', attempts: []};
  const request = {model: 'claude-haiku-5-5', plan: 'max20'};
  await build({state, request, now: NOW, context: {provider: 'claude', accountKey: OTHER}});
  assert.deepEqual(calls.map(([key]) => key), Array(calls.length).fill(OTHER), 'every history read for the scoped key names the whole key: ' + JSON.stringify(calls));
  calls.length = 0;
  await build({state, request, now: NOW, context: {provider: 'claude'}});
  assert.deepEqual(calls.map(([key]) => key), Array(calls.length).fill('claude'), 'the bare provider still reads its own history: ' + JSON.stringify(calls));
  assert.equal(calls.length, 2);
});
