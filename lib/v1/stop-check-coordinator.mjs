/**
 * One stop check per machine, shared by everything that needs it.
 *
 * It decides when the stop check runs (stop-check.mjs); it never produces evidence itself. The rules:
 *   - A valid receipt is enough for admission; lending-on arms background renewal at measured_at + 20 hours.
 *   - No valid receipt: lending-on starts one check without waiting for it, and a claimed job joins it. Concurrent triggers and
 *     accounts share one check (single-flight). The flight is installed before any await.
 *   - The whole check has one fixed deadline (STOP_CHECK_DEADLINE_MS). It never restarts when another job joins. A check that
 *     passes the deadline is aborted, so its late success cannot admit the job that timed out.
 *   - One waiter leaving never cancels the others.
 *   - A failed check is not retried by reads or status polls. Retry rule: a job that arrives within STOP_CHECK_RETRY_COOLDOWN_MS of
 *     a failure is refused at once with the failure status; after the cooldown, the next job arrival starts one new check. An
 *     explicit retry (`retry()`, or turning lending on again) starts one at any time.
 *   - Renewal scheduling is separate from the evidence store's 24-hour admission expiry.
 */
// 180 s waiting for the daemon gate plus the 300 s the gate holds a turn: the same fixed total as the stop check's own bound.
export const STOP_CHECK_DEADLINE_MS = 480_000;
export const STOP_CHECK_RENEWAL_MS = 20 * 60 * 60_000;
export const STOP_CHECK_RETRY_COOLDOWN_MS = 10 * 60_000;

export const STOP_CHECK_LINES = Object.freeze({
  checking: 'Checking this computer can stop a friend\'s job safely',
  failed: 'Stop check failed. Check Docker Sandboxes, then retry the stop check.',
});

export function createStopCheckCoordinator({store, check, binding, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, deadlineMs = STOP_CHECK_DEADLINE_MS,
  cooldownMs = STOP_CHECK_RETRY_COOLDOWN_MS, onChange = () => {}} = {}) {
  if (!store || typeof check !== 'function' || typeof binding !== 'function') throw new TypeError('the coordinator needs a store, a check and a binding');
  let flight = null;          // {promise, controller, generation}
  let failure = null;         // {at, reason}
  let generation = 0;
  let armed = false;
  let renewalEpoch = 0;
  const renewalCurrent = epoch => armed && !closed && epoch === renewalEpoch;
  let closed = false;
  let renewalTimer = null;
  const notify = () => { try { onChange(); } catch { /* A status listener cannot change a check. */ } };

  function begin() {
    const controller = new AbortController();
    const mine = ++generation;
    let timer;
    const deadline = new Promise(resolve => { timer = setTimer(() => { controller.abort(new DOMException('The stop check ran out of time.', 'TimeoutError')); resolve({ok: false, reason: 'timeout'}); }, deadlineMs); timer.unref?.(); });
    const run = Promise.resolve().then(() => check({signal: controller.signal})).catch(() => ({ok: false, reason: 'stop_check_failed'}));
    const promise = Promise.race([run, deadline]).then(result => {
      // A result from a check that is no longer the current flight is ignored.
      if (flight?.generation !== mine) return {ok: false, reason: 'superseded'};
      return result?.ok === true ? {ok: true} : {ok: false, reason: result?.reason ?? 'stop_check_failed'};
    }).finally(() => { clearTimer(timer); });
    flight = {promise, controller, generation: mine};
    const settled = promise.then(result => {
      if (flight?.generation === mine) { flight = null; failure = result.ok ? null : {at: now(), reason: result.reason}; }
      notify();
      return result;
    });
    flight.promise = settled;
    notify();
    return {promise: settled, generation: mine};
  }

  // Waits for a flight without owning it: a waiter's own signal only detaches that waiter.
  const waitFor = (promise, signal) => signal ? new Promise(resolve => {
    if (signal.aborted) return resolve({ok: false, reason: 'cancelled'});
    const onAbort = () => resolve({ok: false, reason: 'cancelled'});
    signal.addEventListener('abort', onAbort, {once: true});
    promise.then(resolve, () => resolve({ok: false, reason: 'stop_check_failed'})).finally(() => signal.removeEventListener('abort', onAbort));
  }) : promise;

  function clearRenewal() {
    if (renewalTimer !== null) clearTimer(renewalTimer);
    renewalTimer = null;
  }

  function scheduleRenewal(delay) {
    if (!armed || closed) return;
    clearRenewal();
    const timer = setTimer(() => {
      if (renewalTimer !== timer || !armed || closed) return;
      renewalTimer = null;
      kickRenewal();
    }, Math.max(0, delay));
    renewalTimer = timer;
    timer.unref?.();
  }

  // Force skips the cooldown only for the owner's explicit actions, not scheduled retries.
  async function startIfNeeded({force = false, renew = false, epoch = renewalEpoch} = {}) {
    if (closed || (renew && !renewalCurrent(epoch))) return null;
    if (flight) return {promise: flight.promise};
    const bound = await binding().catch(() => null);
    if (closed || (renew && !renewalCurrent(epoch))) return null;
    if (flight) return {promise: flight.promise};
    if (!bound) { if (renew) scheduleRenewal(cooldownMs); return null; }
    const receipt = await store.current(bound);
    if (closed || (renew && !renewalCurrent(epoch))) return null;
    if (flight) return {promise: flight.promise};
    if (receipt) {
      if (!renew) return null;
      const dueIn = receipt.measured_at + STOP_CHECK_RENEWAL_MS - now();
      if (dueIn > 0) { scheduleRenewal(dueIn); return null; }
    }
    const retryIn = failure ? cooldownMs - (now() - failure.at) : 0;
    if (!force && retryIn > 0) {
      if (renew) scheduleRenewal(retryIn);
      return null;
    }
    if (renew) clearRenewal();
    return {promise: begin().promise};
  }

  function kickRenewal(force = false) {
    const epoch = renewalEpoch;
    void maintain(force, epoch).catch(() => { if (renewalCurrent(epoch)) scheduleRenewal(cooldownMs); });
  }

  async function maintain(force, epoch) {
    const pending = await startIfNeeded({force, renew: true, epoch});
    if (!pending) return;
    const result = await pending.promise;
    if (!renewalCurrent(epoch)) return;
    if (!result.ok) { scheduleRenewal(cooldownMs); return; }
    const bound = await binding().catch(() => null);
    if (!renewalCurrent(epoch)) return;
    if (!bound) { scheduleRenewal(cooldownMs); return; }
    const receipt = await store.current(bound);
    if (!renewalCurrent(epoch)) return;
    const dueIn = receipt ? receipt.measured_at + STOP_CHECK_RENEWAL_MS - now() : 0;
    // A success without freshly persisted evidence neither admits nor spins a loop.
    scheduleRenewal(dueIn > 0 ? dueIn : cooldownMs);
  }

  return {
    /** Lending turned on (or resumed): arm renewal and check now if evidence is due or unavailable. */
    start() { if (closed) return; armed = true; kickRenewal(true); },
    /** Pause/Off park background renewal without interrupting a shared check. */
    disableRenewal() { armed = false; renewalEpoch++; clearRenewal(); },
    /** The owner's explicit retry. */
    retry() { if (armed) kickRenewal(true); else void startIfNeeded({force: true}).catch(() => {}); },
    /** A claimed job asks for a valid receipt: joins the running check, or starts one. Resolves {ok} or {ok:false, reason}. */
    async ensure({signal} = {}) {
      if (closed || signal?.aborted) return {ok: false, reason: 'cancelled'};
      const joined = await startIfNeeded();
      const result = joined ? await waitFor(joined.promise, signal) : {ok: true};
      // A pass counts only for the runtime that is current now: a check that finished for an older binding admits nothing.
      if (result.ok && !closed) {
        const bound = await binding().catch(() => null);
        if (bound && await store.current(bound) && !closed) return {ok: true};
        return failure ? {ok: false, reason: failure.reason} : {ok: false, reason: joined ? 'stop_check_changed' : 'stop_check_unavailable'};
      }
      return closed ? {ok: false, reason: 'cancelled'} : result;
    },
    /** The state a status line reads. No call here starts a check. */
    async view() {
      const bound = await binding().catch(() => null);
      if (flight) return {state: 'checking', line: STOP_CHECK_LINES.checking};
      const why = bound ? await store.status(bound) : 'missing';
      if (why === null) return {state: 'valid', line: null};
      if (failure) return {state: 'failed', line: STOP_CHECK_LINES.failed, reason: failure.reason};
      return {state: why === 'failed' ? 'failed' : why, line: why === 'failed' ? STOP_CHECK_LINES.failed : null};
    },
    /** True while a check runs. */
    get running() { return flight !== null; },
    /** Permanently disarms renewal and aborts a running check on shutdown. */
    close() { closed = true; armed = false; clearRenewal(); flight?.controller.abort(new DOMException('The app is closing.', 'AbortError')); },
  };
}
