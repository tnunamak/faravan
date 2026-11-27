// One caller-side gate for short sandbox-daemon work. The daemon does not serialize calls, and a quota check that
// is preparing or removing a sandbox can make a job's isolation check time out. Callers take turns here instead.
// Only the quota check's own lifetime and the isolation check hold a turn; a running job never does.
export const DAEMON_TURN_WAIT_MS = 180_000;

export function createDaemonGate({maxWaitMs = DAEMON_TURN_WAIT_MS, setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
  if (!Number.isSafeInteger(maxWaitMs) || maxWaitMs <= 0) throw new TypeError('invalid daemon gate wait bound');
  let held = false;
  const waiters = [];

  const release = () => {
    held = false;
    const next = waiters.shift();
    if (next) next.grant();
  };

  // Waits for a turn, then runs `work` and always gives the turn back, on return, throw or abort.
  // A caller that waits longer than the bound, or whose signal aborts, leaves the line and gets an error.
  async function run(work, {signal, label = 'daemon work', holdMs = null} = {}) {
    if (typeof work !== 'function') throw new TypeError('daemon gate needs a function');
    if (signal?.aborted) throw signal.reason ?? new DOMException('The wait was cancelled.', 'AbortError');
    if (held || waiters.length > 0) {
      await new Promise((resolve, reject) => {
        const waiter = {};
        let timer = null;
        const leave = () => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          if (timer !== null) clearTimer(timer);
          signal?.removeEventListener('abort', onAbort);
        };
        const onAbort = () => { leave(); reject(signal.reason ?? new DOMException('The wait was cancelled.', 'AbortError')); };
        waiter.grant = () => {
          if (timer !== null) clearTimer(timer);
          signal?.removeEventListener('abort', onAbort);
          held = true;
          resolve();
        };
        timer = setTimer(() => {
          leave();
          reject(Object.assign(new Error('The sandbox service stayed busy with other work for ' + Math.round(maxWaitMs / 1000) + ' s before ' + label + ' could start.'),
            {code: 'daemon_busy', waitedMs: maxWaitMs}));
        }, maxWaitMs);
        timer.unref?.();
        signal?.addEventListener('abort', onAbort, {once: true});
        waiters.push(waiter);
      });
    } else held = true;
    // `holdMs` bounds how long a granted turn may stay held. When it passes, the turn goes to the next waiter and the
    // caller gets `daemon_hold_timeout`. The stuck work is not stopped, so the worst case is the overlap this gate removes.
    let released = false, holdTimer = null;
    const releaseOnce = () => { if (!released) { released = true; release(); } };
    try {
      // A cancel that landed between the grant and this line must not start the work.
      if (signal?.aborted) throw signal.reason ?? new DOMException('The wait was cancelled.', 'AbortError');
      const running = Promise.resolve(work());
      if (holdMs === null) return await running;
      running.catch(() => {});
      return await Promise.race([running, new Promise((_, reject) => {
        holdTimer = setTimer(() => reject(Object.assign(new Error('The sandbox service did not finish ' + label + ' within ' + Math.round(holdMs / 1000) + ' s.'),
          {code: 'daemon_hold_timeout', heldMs: holdMs})), holdMs);
        holdTimer.unref?.();
      })]);
    } finally {
      if (holdTimer !== null) clearTimer(holdTimer);
      releaseOnce();
    }
  }

  return {run, get busy() { return held; }, get waiting() { return waiters.length; }};
}
