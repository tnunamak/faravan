import {LIVE_QUOTA_POLL_MS} from './lending-quota-timing.mjs';
// The live meter guard of a native-window job. A native job has no measured conversion, so its dollar size cannot be turned
// into window points. Its allowance is held in window points, and this guard holds the job to it by reading the provider meter
// while the job runs. Reading age alone does not Stop a job. A stop it asks for is only a request.
// The attempt's hold stays open until the lender proves the sandbox gone and a
// reading settles the use (the policy's native_meter_settled transition).
//
// Bound. For one window instance, let A be the allowance and the guard stop at A - M. With q the quantization of a difference of
// two readings, L the provider's reporting lag, P the longest interval between usable guard evaluations, T the bound from a
// stop decision to the effective end of use, R the largest burn rate on the window and B charges batched outside R:
//   overshoot <= q + R*(L + P + T) + B.
// M = q + R*(L + P + T) + B is certified only when every term is known. Otherwise the guard is a soft cap at A: it stops the job
// when a reading shows the allowance used, and reporting or stop delays can let use run past it by an amount no one bounds.
import {MAX_METER_AGE_MS} from './lending-rule-seam.mjs';
import {RESET_JITTER_MS} from './window-origin.mjs';

const MICRO = 1_000_000;
const finiteNonNegative = value => Number.isFinite(value) && value >= 0;

// One shown meter point. A meter shows whole points, so the difference of two readings can be off by up to one point
// (METER_RESOLUTION_POINTS in lending-kappa-measure.mjs; it is the representation, not a vendor quantizer proof).
export const DIFFERENCE_QUANTIZATION_MICRO = MICRO;

/**
 * The certified overshoot margin for one window, in micro-points, or the names of the unknown terms.
 * q, B in micro-points; L, P, T in ms; R in micro-points per ms. Each unknown term is null.
 */
export function nativeOvershootBound({q = DIFFERENCE_QUANTIZATION_MICRO, L = null, P = null, T = null, R = null, B = null} = {}) {
  const terms = {q, L, P, T, R, B};
  const unknown = Object.entries(terms).filter(([, value]) => !finiteNonNegative(value)).map(([name]) => name);
  if (unknown.length) return {certified: false, unknown, marginMicro: null};
  return {certified: true, unknown: [], marginMicro: Math.ceil(q + R * (L + P + T) + B)};
}

/**
 * The stop threshold for one window: the allowance less a certified margin when one exists and leaves a positive threshold,
 * else the allowance itself (a soft cap).
 */
export function nativeStopThreshold(allowanceMicro, bound) {
  if (bound?.certified === true && allowanceMicro - bound.marginMicro > 0)
    return {thresholdMicro: allowanceMicro - bound.marginMicro, certified: true};
  return {thresholdMicro: allowanceMicro, certified: false};
}

/**
 * The guard. `read(watch)` returns a fresh observation for the attempt's provider (the source's observe shape). `stop(attemptId,
 * reason)` requests cessation. Timers are injected so tests run the watchdog with fake time and no token events.
 * A read that hangs cannot delay owner Stop. Missing readings do not establish exhaustion.
 */
// A funding fact that is only missing (no reason, or a reason that says the fact was not observed) is not evidence of other
// funding. Any other non-proven reason (extra usage on, another API provider, a non-subscription plan, a reached limit) is.
const fundingUnobserved = funding => funding?.reason == null || /_unobserved$/.test(funding.reason);

export function createNativeGuard({now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, read, stop,
  freshnessMs = MAX_METER_AGE_MS, bounds = () => null, onBind = () => {}} = {}) {
  if (typeof read !== 'function' || typeof stop !== 'function') throw new TypeError('the native guard needs read and stop');
  if (!(Number.isSafeInteger(freshnessMs) && freshnessMs > 0)) throw new TypeError('the native guard needs a freshness bound');
  const watches = new Map();

  const clear = watch => {
    if (watch.deadline) clearTimer(watch.deadline);
    if (watch.poll) clearTimer(watch.poll);
    watch.deadline = null; watch.poll = null;
  };
  const halt = (watch, reason, detail = {}, request = true) => {
    if (watch.stopReason) return;
    watch.stopReason = reason;
    watch.stopRequestedAt = now();
    watch.stopDetail = detail;
    clear(watch);
    // A stop request is not cessation. The caller's cessation path proves the sandbox gone.
    if(request)Promise.resolve().then(() => stop(watch.attemptId, reason)).catch(() => {});
  };
  // Reading age is uncertainty, never a Stop condition. Window reset and budget checks remain.
  const armDeadline = watch => { if (watch.deadline) clearTimer(watch.deadline); };
  const armPoll = (watch, {retry = false} = {}) => {
    if (watch.poll) clearTimer(watch.poll);
    const due = LIVE_QUOTA_POLL_MS;
    watch.poll = setTimer(() => { watch.poll = null; poll(watch); }, due);
    watch.poll?.unref?.();
  };
  const poll = async watch => {
    if (watch.stopReason || watch.reading) return;
    watch.reading = true;
    const started = now();
    let observation = null;
    try { observation = await read(watch); } catch { observation = null; }
    watch.reading = false;
    if (watch.stopReason || !watches.has(watch.attemptId)) return;
    watch.readMs = Math.max(0, now() - started);
    const used = observation ? offer(watch.attemptId, observation) : {usable: false};
    // A failed or deferred read adds uncertainty; poll again without an age-only Stop.
    if (!used.usable && !watch.stopReason) armPoll(watch, {retry: true});
  };

  // A reading the guard may act on. Positive evidence of another account, funding or epoch stops the job at once. A reading
  // that is merely unusable (refresh failed, account busy, identity or funding not observed, no epoch) is ignored.
  function offer(attemptId, observation) {
    const watch = watches.get(attemptId);
    if (!watch || watch.stopReason) return {usable: false};
    if (observation?.refresh_succeeded !== true || observation.complete !== true || !Array.isArray(observation.resources))
      return {usable: false};
    const identity = observation.identity;
    if (identity?.verified === true ? identity.account_id !== watch.accountId : identity?.reason === 'identity_mismatch') {
      halt(watch, 'identity_changed'); return {usable: true, stopped: true};
    }
    const funding = observation.funding;
    if (funding?.subscription_only !== 'proven' && !fundingUnobserved(funding)) {
      halt(watch, 'funding_changed'); return {usable: true, stopped: true};
    }
    if (observation.epoch != null && observation.epoch !== watch.epoch) {
      halt(watch, 'epoch_changed'); return {usable: true, stopped: true};
    }
    if (identity?.verified !== true || funding?.subscription_only !== 'proven' || observation.epoch == null) return {usable: false};
    const at = observation.observed_at;
    if (!Number.isSafeInteger(at) || at > now() || at < watch.lastFreshAt) return {usable: false};
    watch.lastObservation = observation;
    return evaluate(watch, at, id => observation.resources.find(r => r.id === id) ?? null);
  }
  // The stop deadline of one reserved window. A binding can only bring it earlier, never later.
  const deadline = r => r.bound ? Math.min(r.resets_at, r.bound.resets_at) : r.resets_at;

  // The job's own in-band meter lines ({window_id, used_pct, resets_at}). They come through the sandbox's stderr, so the borrower
  // can forge them. They may only add a stop: a rise at or over the threshold, or a reset, stops the job. They never count as a
  // fresh reading: they do not move lastFreshAt, re-arm the stale deadline or the host poll, or make a later host reading look old.
  function offerInband(attemptId, windows, at = now()) {
    const watch = watches.get(attemptId);
    if (!watch || watch.stopReason || !Array.isArray(windows)) return {usable: false, stopped: false};
    const lines = windows.filter(w => typeof w?.window_id === 'string' && Number.isFinite(w.used_pct));
    for (const r of watch.resources) {
      const line = lines.find(w => w.window_id === r.id);
      if (!line) continue;
      const resets = typeof line.resets_at === 'number' ? line.resets_at : Date.parse(line.resets_at);
      // A cold window that has not been bound may open at any reset from the reserved one on.
      const moved = r.cold && !r.bound ? resets < r.resets_at - RESET_JITTER_MS : Math.abs(resets - (r.bound ?? r).resets_at) > RESET_JITTER_MS;
      if (Number.isFinite(resets) && moved || at >= deadline(r)) {
        halt(watch, 'window_reset', {resource_id: r.id, inband: true}); return {usable: false, stopped: true};
      }
      const rise = Math.ceil(line.used_pct * MICRO) - r.baseline_used_micro;
      if (rise >= r.thresholdMicro) {
        halt(watch, 'allowance_reached', {resource_id: r.id, rise_micro: rise, threshold_micro: r.thresholdMicro,
          certified: r.certified, inband: true});
        return {usable: false, stopped: true};
      }
    }
    return {usable: false, stopped: false};
  }

  // A host-origin reading: the only kind that refreshes the deadline and the poll.
  function evaluate(watch, at, find) {
    const binds = [];
    for (const r of watch.resources) {
      const seen = find(r.id);
      if (!seen || !Number.isSafeInteger(seen.used_micro)) return {usable: false};
      // A cold window was reserved before it opened, at the earliest reset it can have. While the provider still reports it
      // not open it has no use. The first open reading of it, at or after that reset less the reset jitter, is the window this
      // reservation is bound to; that says nothing about who opened it. Every later reading must be of that window, within the
      // same jitter. The job still ends at the reserved reset, or at the bound reset when that is earlier.
      const opened = r.cold && !r.bound && seen.cold_open !== true && seen.state === 'open' &&
        Number.isSafeInteger(seen.resets_at) && seen.resets_at >= r.resets_at - RESET_JITTER_MS;
      const same = !r.cold ? seen.instance === r.instance && seen.resets_at === r.resets_at
        : !r.bound ? seen.cold_open === true || opened
          : seen.cold_open !== true && Number.isSafeInteger(seen.resets_at) && Math.abs(seen.resets_at - r.bound.resets_at) <= RESET_JITTER_MS;
      // A later window instance means the reserved one reset. The reserved instance can no longer be read.
      if (!same || at >= deadline(r)) {
        halt(watch, 'window_reset', {resource_id: r.id}); return {usable: true, stopped: true};
      }
      if (opened) binds.push([r, {instance: seen.instance, anchor_at: seen.anchor_at, resets_at: seen.resets_at}]);
    }
    watch.lastFreshAt = at;
    watch.freshnessMs = freshnessMs;
    for (const [r, bound] of binds) {
      r.bound = bound;
      try { onBind(watch.attemptId, r.id, bound, {reserved_resets_at: r.resets_at, observation: watch.lastObservation}); }
      catch { /* The binding still holds the guard to the window. */ }
    }
    for (const r of watch.resources) {
      // Owner use since the cached baseline also counts against this job, favouring the lender.
      const rise = find(r.id).used_micro - r.baseline_used_micro;
      // An unchanged meter never adds allowance: the rise is measured from the fixed admission baseline.
      if (rise >= r.thresholdMicro) {
        halt(watch, 'allowance_reached', {resource_id: r.id, rise_micro: rise, threshold_micro: r.thresholdMicro,
          certified: r.certified});
        return {usable: true, stopped: true};
      }
    }
    armDeadline(watch);
    armPoll(watch);
    return {usable: true, stopped: false};
  }

  return {
    /**
     * Start guarding one attempt. `resources` are the durable ledger rows: id, instance, resets_at, baseline_used_micro and
     * initial_micro (the allowance). `lastFreshAt` is the time of the reading the allowance was taken from. `cold` names the
     * resources reserved while their window was not open; `onBind` learns the instance each one opened as.
     */
    watch({attemptId, provider, accountId, epoch, resources, lastFreshAt, cold = [], freshnessMs:readingFreshnessMs = freshnessMs}) {
      if (watches.has(attemptId)) return watches.get(attemptId);
      if (!Number.isSafeInteger(readingFreshnessMs) || readingFreshnessMs <= 0)
        throw new TypeError('the native guard needs a freshness bound');
      const watch = {attemptId, provider, accountId, epoch, lastFreshAt, freshnessMs:readingFreshnessMs, readMs: null, reading: false,
        deadline: null, poll: null, stopReason: null, stopRequestedAt: null, stopDetail: null,
        resources: resources.map(r => {
          const threshold = nativeStopThreshold(r.initial_micro, bounds({provider, resource: r}));
          return {id: r.id, instance: r.instance, resets_at: r.resets_at, baseline_used_micro: r.baseline_used_micro,
            allowance_micro: r.initial_micro, thresholdMicro: threshold.thresholdMicro, certified: threshold.certified,
            cold: cold.includes(r.id), bound: null};
        })};
      watches.set(attemptId, watch);
      armDeadline(watch); armPoll(watch);
      return watch;
    },
    offer,
    offerInband,
    // The owner's stop is recorded like any other stop reason; the route's own cessation request does the stopping.
    ownerStop(attemptId, {request = true} = {}) { const watch = watches.get(attemptId); if (watch) halt(watch, 'owner_stop', {}, request); },
    // A stop the lender decides from outside the meter read, such as a failed admission check against a bound window.
    stopFor(attemptId, reason) { const watch = watches.get(attemptId); if (watch) halt(watch, reason); },
    unwatch(attemptId) { const watch = watches.get(attemptId); if (watch) { clear(watch); watches.delete(attemptId); } },
    status(attemptId) {
      const watch = watches.get(attemptId);
      return watch ? {stop_reason: watch.stopReason, stop_requested_at: watch.stopRequestedAt, last_fresh_at: watch.lastFreshAt,
        stop_detail: watch.stopDetail, cessation_proven: false} : null;
    },
    watching: () => [...watches.keys()],
  };
}
