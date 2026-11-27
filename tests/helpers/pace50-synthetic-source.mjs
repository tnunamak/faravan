// Trusted SYNTHETIC evidence for tests and internal startup options only. It is not a provider
// observation, it is never qualification, and no product path may use it on a real account. The
// `proofs` argument states which facts the test asserts. Each one is named in the test that uses it.
const MICRO = 1_000_000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const STOP_BOUND_MS = 60_000;
export const SYNTHETIC_RESET = {weekly: 42 * 3600000, short: 1.25 * 3600000};

export function createSyntheticPace50Source({
  account = 'synthetic-account',
  accountWeek = 'synthetic-week-1',
  epoch = 'epoch-1',
  start = Date.UTC(2026, 9, 23, 10, 0, 0),
  resets = SYNTHETIC_RESET,
  used = {weekly: 20000000, short: 40000000},
  kappa = {weekly: 50000, short: 200000},
  proofs = {identity: true, funding: 'proven', executor: 'proven', stop: 'proven'},
  // Optional per-test override of an observation (for example, a stale reading or a missing window).
  override = null,
} = {}) {
  const state = {used: {...used}};
  const history = {weeklyScores(resource) {
    const weekStart = start + resets.weekly - 7 * 86400000;
    return new Map(Array.from({length: 19}, (_, i) => {
      const epoch = weekStart - (19 - i) * WEEK_MS;
      return [epoch, {epoch, end: epoch, resource, score: 0, complete: true, reason: null}];
    }));
  }};
  // Window ids follow the real meter vocabulary: Claude names them, Codex uses codex:<minutes>.
  const ids = provider => provider === 'codex' ? {weekly: 'codex:10080', short: 'codex:300'} : {weekly: 'seven_day', short: 'five_hour'};
  const windowsAt = (now, provider) => {
    // Whole-point readings: uncertainty_micro is one point, as the real source declares (lending-pace50-source.mjs).
    const window = (id, kind, usedMicro, offset, duration) => {
      const reset = start + offset, anchor = reset - duration;
      return {id, kind, instance: `synthetic-${id}-1`, state: 'open', anchor_at: anchor, resets_at: reset,
        duration_ms: duration, observed_at: now, used_micro: usedMicro, owner_used_micro: usedMicro,
        kappa_micro: kappa[kind === 'weekly' ? 'weekly' : 'short'],
        kappa_lower_micro: kappa[kind === 'weekly' ? 'weekly' : 'short'], uncertainty_micro: MICRO,
        origin: kind === 'short' ? 'owner' : null};
    };
    return [window(ids(provider).weekly, 'weekly', state.used.weekly, resets.weekly, 7 * 86400000),
      window(ids(provider).short, 'short', state.used.short, resets.short, 5 * 3600000)];
  };
  return {
    kind: 'synthetic',
    stop_bound_ms: STOP_BOUND_MS,
    uncertainty_ms: 0,
    state,
    history,
    async observe({provider, now}) {
      const resources = windowsAt(now, provider);
      const base = {
        refresh_succeeded: true,
        complete: true,
        resources,
        weekly_resource_id: ids(provider).weekly,
        identity: proofs.identity ? {verified: true, account_id: account} : {verified: false},
        // A provider switch proves its account week from the weekly reset.
        account_week_id: provider === 'codex' ? `${account}:weekly:${resources.find(r => r.kind === 'weekly').resets_at}` : accountWeek,
        epoch,
        funding: {subscription_only: proofs.funding},
        executor: {single_executor: proofs.executor},
        stop: {bounded_execution: proofs.stop},
        stop_bound_ms: proofs.stop === 'proven' ? STOP_BOUND_MS : null,
        uncertainty_ms: 0,
        opening_anchor_known: false,
        resource_coupling_known: false,
        provider,
        observed_at: now,
      };
      return override ? override({base, now}) : base;
    },
    // Fixture-backed objective evidence. It names a complete empty queue and
    // nineteen complete weeks so tests reach the durable allocator; real sources
    // have no such callback and hold until their trusted producers are installed.
    objectiveInputFor({state: durable, request, now, input}) {
      const ids = input.windows.map(resource => resource.id);
      const weekly = input.windows.find(resource => resource.kind === 'weekly');
      const domain = ids.map(id => id + '@decision');
      const band = {weekStart: weekly.anchor_at, epoch: 'synthetic-history-epoch/1',
        procedure: 'synthetic-history-procedure/1', domain,
        weeks: Array.from({length: 19}, (_, i) => ({id: `synthetic-week-${i}`,
          end: weekly.anchor_at - (19 - i) * WEEK_MS, epoch: 'synthetic-history-epoch/1',
          procedure: 'synthetic-history-procedure/1', complete: true,
          upperScores: Object.fromEntries(domain.map(label => [label, 0]))})),
        forecasts: ids.map(id => ({id, domain: id + '@decision', prediction: 0, scale: 1}))};
      const windows = Object.fromEntries(input.windows.map(resource => {
        const committedMicro = durable.attempts.flatMap(attempt => attempt.resources)
          .filter(row => row.id === resource.id && row.instance === resource.instance)
          .reduce((sum, row) => sum + row.held_micro + row.unrepresented_micro, 0);
        return [resource.id, {known: true, fresh: true, compatible: true, kind: resource.kind,
          usedMicro: resource.used_micro, committedMicro, pointsPerUsdMicro: resource.kappa_micro,
          pointsPerUsdLowerMicro: resource.kappa_lower_micro, resetAtMs: resource.resets_at,
          uncertaintyMicro: resource.uncertainty_micro ?? 0, anchorAtMs: resource.anchor_at,
          durationMs: resource.duration_ms, ownerUsedMicro: resource.owner_used_micro ?? resource.used_micro}];
      }));
      const need = Object.fromEntries(ids.map(id => [id, 0]));
      const controls = input.controls;
      return {now, observedAt: Math.min(...input.windows.map(resource => resource.observed_at)),
        position: 'balanced', weeklyResource: input.weekly_resource_id, windows, band,
        owner: {scenarios: [{probability: 1, attempts: [{need, value: 0, atomic: false}]}]},
        gates: {consent: controls.consent, limits: controls.people && controls.agents && controls.schedule && controls.unexpired,
          funding: true, stopping: controls.on && !controls.paused && controls.owner_absent},
        stopped: !controls.on || controls.paused || !controls.owner_absent,
        laterBurnCapacityMicro: 0,
        job: {id: request.job_id, friendValue: 100, estimateUsdMicro: request.requested_usd_micro ?? 10 * MICRO,
          requestedUsdMicro: request.requested_usd_micro, worstCallUsdMicro: 1_320_000,
          wallMs: request.wall_ms, stopMs: request.stop_ms, uncertaintyMs: request.uncertainty_ms}};
    },
    // Converts a metered amount in micro units of the controllable unit to per-resource micro points. A conversion is a charge computation:
    // it does not move the provider's meter. The sandbox moves the meter when it meters a run (pace50-app-sandbox), and a test moves it by hand.
    convertUsage({units_micro, resources}) {
      if (!Number.isSafeInteger(units_micro) || units_micro < 0 || !Array.isArray(resources) || resources.length === 0 ||
          resources.some(resource => !Number.isSafeInteger(resource?.kappa_micro) || resource.kappa_micro <= 0)) return null;
      const burns = resources.map(resource => {
        const amount = (BigInt(resource.kappa_micro) * BigInt(units_micro) + BigInt(MICRO - 1)) / BigInt(MICRO);
        return amount <= BigInt(Number.MAX_SAFE_INTEGER) ? {id: resource.id, instance: resource.instance,
          amount_micro: Number(amount)} : null;
      });
      return burns.every(Boolean) ? burns : null;
    },
  };
}
