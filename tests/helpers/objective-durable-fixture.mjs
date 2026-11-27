import fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPace50Candidate} from '../../lib/v1/lender-pace50.mjs';
import {claudeCallHeadroomUsd} from '../../lib/v1/lending-meter.mjs';
import {createSyntheticPace50Source, SYNTHETIC_RESET} from './pace50-synthetic-source.mjs';
import {ACCOUNT, MICRO, NOW, WEEK} from './pace50-fixtures.mjs';

// Shared by the durable-acceptance tests. The fixture's posting-lag bound defaults to a measured value; pass
// postingLagBoundMs: null for the production default.
export const HAIKU = 'claude-haiku-5-5';
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const noopEffects = {
  arm_cessation_deadline: async () => () => {},
  launch_chunk: async () => {},
  open_short_window: async () => {},
  cancel_pending_attempt: async () => {},
  request_cessation: async () => {},
  request_fresh_complete_reconciliation: async () => {},
};

function history({weeks = 19, score = 0} = {}) {
  return {weeklyScores(resource) {
    const start = NOW - 30 * WEEK_MS;
    return new Map(Array.from({length: weeks}, (_, index) => {
      const end = start + (index + 1) * WEEK_MS;
      return [end, {epoch: end, start: end - WEEK_MS, end, resource, score, ownerUsagePct: score,
        complete: true, reason: null, source: 'meter'}];
    }));
  }};
}

function makeJob(now, {requestedUsd = 3, wallSeconds = 60} = {}) {
  return {
    requirements: {limits: {wall_seconds: wallSeconds}},
    expires_at: new Date(now + 60 * 60_000).toISOString(),
    ...(requestedUsd === null ? {} : {budget_v1: {max_list_usd: requestedUsd}}),
  };
}

export function fixture(t, {used = {weekly: 10 * MICRO, short: 0}, kappa = {weekly: MICRO, short: MICRO},
  historyWeeks = 19, historyScore = 0, ownerCapUsd = null, profile = {}, resets = SYNTHETIC_RESET,
  strategy='automatic',strategyParams=undefined,postingLagBoundMs=120000}={}) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'm1-obj-durable-'));
  const clock = {at: NOW};
  const source = createSyntheticPace50Source({start: NOW, used, kappa, resets});
  source.history = history({weeks: historyWeeks, score: historyScore});
  source.objectiveInputFor = ({request, now, input, band}) => {
    const forecasts = band.forecasts.map(row => ({...row,
      prediction: profile.forecastPoints?.[row.id] ?? 0,
    }));
    const ownerScenarios = profile.ownerScenarios ?? [{probability: 1, attempts: [{
      need: {seven_day: 0, five_hour: 0}, value: 0, atomic: false,
    }]}];
    return {
      now,
      observedAt: Math.min(...input.windows.map(row => row.observed_at)),
      windows: Object.fromEntries(input.windows.map(row => [row.id, {
        known: true, fresh: true, compatible: true, kind: row.kind,
        usedMicro: row.used_micro, committedMicro: 0, pointsPerUsdMicro: row.kappa_micro,
        pointsPerUsdLowerMicro: row.kappa_lower_micro, resetAtMs: row.resets_at,
        uncertaintyMicro: row.uncertainty_micro ?? 0, anchorAtMs: row.anchor_at, durationMs: row.duration_ms,
        ownerUsedMicro: row.owner_used_micro ?? row.used_micro, paceRateMicroPerHour: row.pace_rate_micro_per_hour,
      }])),
      weeklyResource: input.weekly_resource_id,
      band: {...band, forecasts},
      position: profile.position ?? 'keep_more_for_me', strategy, strategyParams,
      owner: {scenarios: ownerScenarios},
      gates: {consent: input.controls.consent, limits: input.controls.people && input.controls.agents &&
        input.controls.schedule && input.controls.unexpired, funding: input.evidence.subscription_only,
        stopping: input.controls.on && !input.controls.paused && input.controls.owner_absent},
      laterBurnCapacityMicro: profile.laterBurnCapacityMicro ?? 0,
      job: {
        id: request.job_id,
        friendValue: profile.friendValue ?? 3,
        estimateUsdMicro: profile.estimateUsdMicro ?? request.requested_usd_micro ?? 20 * MICRO,
        requestedUsdMicro: request.requested_usd_micro,
        worstCallUsdMicro: Math.round(claudeCallHeadroomUsd(request.model) * MICRO),
        wallMs: request.wall_ms, stopMs: request.stop_ms, uncertaintyMs: request.uncertainty_ms,
      },
    };
  };
  const ownerSettings = ownerCapUsd === null ? null : {limit: () => ({state: 'set', maxJobUsd: ownerCapUsd})};
  const opened = createPace50Candidate({postingLagBoundMs,directory, now: () => clock.at, account: ACCOUNT,
    account_week_id: WEEK, source, effects: noopEffects, contextFor: () => ({plan: 'max20', protectionPosition: 'balanced',
      strategy, strategyParams}),
    ownerSettings});
  t.after(async () => {
    await opened.adapter.close();
    fs.rmSync(directory, {recursive: true, force: true});
  });
  return {clock, source, directory, ...opened};
}

export function attemptJob(id, now, options) {
  return {attemptId: `attempt-${id}`, jobId: `job-${id}`, provider: 'claude', model: HAIKU,
    job: makeJob(now, options), automatic: true, ownerAbsent: true};
}

export async function decision(f, id, {model = HAIKU, requestedUsd = 3} = {}) {
  const args = attemptJob(id, f.clock.at, {requestedUsd});
  args.model = model;
  return f.candidate.preview({attemptId: args.attemptId, jobId: args.jobId, job: args.job,
    provider: args.provider, model, automatic: true, ownerAbsent: true});
}

