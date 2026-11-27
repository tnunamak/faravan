import { watermarkStep } from './disk-sweep-plan.mjs';

// When the disk sweep runs. The plan decides WHAT may go; this file only decides
// WHEN to try. Three triggers: once right after readiness, on a timer, and under
// disk pressure (below the start watermark, until the stop watermark). Pressure
// never changes what is eligible.

export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const PRESSURE_CHECK_MS = 10 * 60 * 1000;
export const SWEEP_JITTER = 0.1;
export const SWEEP_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

export function createSweepScheduler({ sweeper, hostFree, ready, timers = { setTimeout, clearTimeout }, random = Math.random, now = Date.now, onError = () => {}, onFree = () => {}, onSummary = () => {} }) {
  let inFlight = null;
  const callbacks = new Set();
  const track = work => {
    callbacks.add(work);
    work.finally(() => callbacks.delete(work)).catch(() => {});
    return work;
  };
  let failures = 0;
  let collecting = false;
  let stopped = false;
  // After a failed sweep no automatic trigger (timer or pressure) may start another before this time.
  let blockedUntil = 0;
  let sweepTimer = null;
  let pressureTimer = null;

  const arm = (fn, ms) => {
    const handle = timers.setTimeout(fn, ms);
    handle?.unref?.();
    return handle;
  };

  function nextDelay() {
    const base = Math.min(SWEEP_BACKOFF_MAX_MS, SWEEP_INTERVAL_MS * 2 ** failures);
    const jittered = base * (1 + (random() * 2 - 1) * SWEEP_JITTER);
    return Math.min(SWEEP_BACKOFF_MAX_MS, Math.max(1, Math.round(jittered)));
  }

  // One sweep at a time: a trigger that arrives meanwhile is dropped, not queued.
  function trigger(name) {
    if (inFlight || stopped) return Promise.resolve({ skipped: 'busy' });
    inFlight = (async () => {
      try {
        const summary = await sweeper.run({ trigger: name });
        if (stopped || summary?.skipped || summary?.aborted) return summary;
        failures = summary?.errors?.length ? failures + 1 : 0;
        blockedUntil = failures ? now() + nextDelay() : 0;
        try { onSummary(summary); } catch (error) { onError(error); }
        return summary;
      } catch (error) {
        if (stopped) return { aborted: true };
        failures += 1;
        blockedUntil = now() + nextDelay();
        onError(error);
        return { error: String(error?.message ?? error) };
      } finally { inFlight = null; }
    })();
    return inFlight;
  }

  function armSweep() {
    if (stopped) return;
    // A timer armed before a failure still obeys the backoff that failure set: it waits, then tries at its next turn.
    sweepTimer = arm(() => track((async () => {
      sweepTimer = null;
      if (stopped) return;
      if (now() >= blockedUntil) await trigger('timer');
      if (stopped) return;
      armSweep();
    })()), nextDelay());
  }

  function armPressure() {
    if (stopped) return;
    pressureTimer = arm(() => track((async () => {
      pressureTimer = null;
      if (stopped) return;
      try {
        const free = await hostFree();
        if (stopped) return;
        try { onFree(free); } catch (error) { onError(error); }
        collecting = watermarkStep({ freeBytes: free, collecting });
        if (collecting && now() >= blockedUntil) await trigger('pressure');
      } catch (error) { if (!stopped) onError(error); }
      if (stopped) return;
      armPressure();
    })()), PRESSURE_CHECK_MS);
  }

  return {
    get inFlight() { return inFlight !== null; },
    trigger,
    // Nothing is armed, and nothing runs, until the app reports it is ready.
    start() {
      Promise.resolve(ready).then(() => {
        if (stopped) return;
        return track((async () => {
          await trigger('startup');
          if (stopped) return;
          try {
            const free = await hostFree();
            if (stopped) return;
            onFree(free);
          } catch (error) { if (!stopped) onError(error); }
          if (stopped) return;
          armSweep();
          armPressure();
        })());
      }).catch(error => { if (!stopped) onError(error); });
    },
    // Quit: stop everything now, without waiting. A sweep in flight is cancelled; stop() drains active callbacks as well.
    abort() {
      stopped = true;
      if (sweepTimer !== null) timers.clearTimeout(sweepTimer);
      if (pressureTimer !== null) timers.clearTimeout(pressureTimer);
      sweepTimer = pressureTimer = null;
      sweeper.abort?.();
    },
    async stop() {
      stopped = true;
      sweeper.abort?.();
      if (sweepTimer !== null) timers.clearTimeout(sweepTimer);
      if (pressureTimer !== null) timers.clearTimeout(pressureTimer);
      sweepTimer = pressureTimer = null;
      await Promise.allSettled([inFlight, ...callbacks]);
    },
  };
}
