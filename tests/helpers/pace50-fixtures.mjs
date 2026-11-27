// Synthetic estimated-pace50 inputs for durable-adapter tests. Every value is invented.
// Nothing here came from a provider, an account, or a billing record.
export const MICRO = 1000000;
export const HOUR_MS = 3600000;
export const DAY_MS = 86400000;
export const NOW = Date.UTC(2026, 9, 22, 10, 0, 0);
export const ACCOUNT = 'synthetic-account';
export const WEEK = 'synthetic-week-1';

export function controls(patch = {}) {
  return {consent: true, people: true, agents: true, schedule: true, unexpired: true,
    on: true, paused: false, owner_absent: true, ...patch};
}

export function request(patch = {}) {
  // The synthetic request carries its own requested total spend. There are no
  // volume caps or fixed quote defaults in the objective path.
  return {attempt_id: 'attempt-1', job_id: 'job-1', requested_usd_micro: 10 * MICRO,
    wall_ms: 300000, stop_ms: 60000, uncertainty_ms: 30000,
    expires_at: NOW + 7 * DAY_MS,
    resumable: true, ...patch};
}

export function evidence(ids, patch = {}) {
  return {complete: true, refresh_succeeded: true, subscription_only: true, bounded_execution: true,
    single_executor: true, identity_compatible: true, no_unresolved_exposure: true, resource_ids: ids,
    account_week_mapping_known: true, opening_anchor_known: true, resource_coupling_known: true, ...patch};
}

export function weekly(now = NOW, patch = {}) {
  const duration = 7 * DAY_MS, reset = now + 42 * HOUR_MS;
  return {id: 'weekly', kind: 'weekly', instance: 'weekly-1', account: ACCOUNT, epoch: 'epoch-1', state: 'open',
    anchor_at: reset - duration, resets_at: reset, duration_ms: duration, observed_at: now,
    used_micro: 20 * MICRO, kappa_micro: 50000, ...patch};
}

// An owner-opened five-hour window, already open.
export function short(now = NOW, patch = {}) {
  const duration = 5 * HOUR_MS, reset = now + 1.25 * HOUR_MS;
  return {id: 'short', kind: 'short', instance: 'short-1', account: ACCOUNT, epoch: 'epoch-1', state: 'open',
    origin: 'owner', anchor_at: reset - duration, resets_at: reset, duration_ms: duration, observed_at: now,
    used_micro: 40 * MICRO, kappa_micro: 200000, ...patch};
}

// An unopened five-hour window that a quiet opening may start at `now`.
export function unopenedShort(now = NOW) {
  return short(now, {state: 'not_open', origin: undefined, instance: 'short-quiet-1', anchor_at: now,
    resets_at: now + 5 * HOUR_MS, duration_ms: 5 * HOUR_MS, used_micro: 0});
}

// Input for an ordinary admission. The adapter overrides now, state and request.
export function ordinaryInput({now, windows = [weekly(now), short(now)], accountWeek = WEEK, controlsPatch = {}, evidencePatch = {}}) {
  const weeklyWindow = windows.find(window => window.kind === 'weekly');
  const domain = windows.map(window => `${window.id}@decision`);
  const objective = {
    position: 'balanced',
    band: {weekStart: weeklyWindow.anchor_at, epoch: 'synthetic-history/1', procedure: 'synthetic-history/1', domain,
      weeks: Array.from({length: 19}, (_, index) => ({id: `synthetic-week-${index}`,
        end: weeklyWindow.anchor_at - (19 - index) * 7 * DAY_MS,
        epoch: 'synthetic-history/1', procedure: 'synthetic-history/1', complete: true,
        upperScores: Object.fromEntries(domain.map(id => [id, 0]))})),
      forecasts: windows.map(window => ({id: window.id, domain: `${window.id}@decision`, prediction: 0, scale: 1}))},
    owner: {scenarios: [{probability: 1, attempts: []}]},
    laterBurnCapacityMicro: 0,
    job: {friendValue: 100, estimateUsdMicro: 10 * MICRO, worstCallUsdMicro: 1_320_000},
  };
  return {now, account: ACCOUNT, account_week_id: accountWeek, epoch: 'epoch-1', weekly_resource_id: 'weekly',
    windows, controls: controls(controlsPatch), evidence: evidence(windows.map((w) => w.id), evidencePatch), objective};
}

// Input for a quiet opening. Local absence must already be recorded in state (owner_absent_since).
export function quietInput({now, state, accountWeek = WEEK}) {
  const windows = [weekly(now), unopenedShort(now)];
  const prior = {at: now - 15 * 60000, account: ACCOUNT, epoch: 'epoch-1', complete: true, compatible: true,
    refresh_succeeded: true, resources: windows.map((w) => ({id: w.id, instance: w.instance, state: w.state,
      anchor_at: w.anchor_at, resets_at: w.resets_at, used_micro: w.used_micro}))};
  return {...ordinaryInput({now, windows, accountWeek}),
    quiet_opening: {local_absent_since: state.owner_absent_since, owner_hold: false, previous: prior}};
}
