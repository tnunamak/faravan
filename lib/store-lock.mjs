import path from 'node:path';
import { tryLock, tryLockAsync, ASYNC_WAIT_MS } from './os-lock.mjs';

// Locks for one sbx store. Three uses share one mechanism (lib/os-lock.mjs, a lock the
// kernel releases when its holder dies):
//   - the ledger's read-modify-write (a few milliseconds, taken synchronously);
//   - the dispatch lock (the gate): every create, reuse, renewal and removal takes it, so a
//     removal is decided and issued with no create or lease change in between;
//   - the sweep lock: held for a whole sweep, taken without waiting, so two instances on
//     one store never sweep at once (one sweeps, the other skips with a reason).
// A live holder is never displaced: there is no age limit and no process-id guess. A holder
// that died frees its lock by dying.

export const LEDGER_LOCK_WAIT_MS = 500;
const sleepSync = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Runs `fn` while holding `file`, waiting up to `timeoutMs` for it. For tiny critical sections only:
// the wait is bounded below the app's shutdown cutoff.
export function withFileLockSync(file, fn, { timeoutMs = LEDGER_LOCK_WAIT_MS } = {}) {
  const until = Date.now() + timeoutMs;
  let handle;
  while (!(handle = tryLock(file))) {
    if (Date.now() >= until) throw Object.assign(new Error('The disk ledger is locked by another process.'), { code: 'ledger_locked' });
    sleepSync(5);
  }
  try { return fn(); } finally { handle.release(); }
}

// The coordination point of one store. `dir` is the sbx HOME. Every instance has its own queue,
// so two instances in one process exclude each other exactly as two processes do (the kernel
// lock refuses a second holder of one name inside a single process too).
export function createStoreCoordinator({ dir, pollMs = 10 } = {}) {
  const dispatchFile = path.join(dir, 'disk-dispatch.lock');
  const sweepFile = path.join(dir, 'disk-sweep.lock');
  let queue = Promise.resolve();
  let sweeping = false;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

  // Waits for `promise` until `until` (a clock time) or until `signal` aborts, whichever is first.
  // The wait ends; `promise` itself is not cancelled.
  function waitFor(promise, until, signal) {
    return new Promise((resolve, reject) => {
      let timer;
      const onAbort = () => { cleanup(); reject(signal.reason ?? Object.assign(new Error('The wait was cancelled.'), { name: 'AbortError', code: 'aborted' })); };
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener?.('abort', onAbort); };
      if (signal?.aborted) return onAbort();
      timer = setTimeout(() => { cleanup(); reject(Object.assign(new Error('The sandbox store is busy.'), { code: 'store_busy' })); }, Math.max(0, until - Date.now()));
      signal?.addEventListener?.('abort', onAbort, { once: true });
      promise.then(() => { cleanup(); resolve(); }, () => { cleanup(); resolve(); });
    });
  }

  // Takes the gate and returns a release function. The caller must call it exactly once;
  // `held()` says whether the lock is still held (it is not after the lock helper stopped).
  // The deadline starts when the call is made, before the wait in the local queue, and a queued
  // call can be cancelled or time out at once. A call that gives up while queued still keeps its
  // place in the chain until the call ahead of it ends, so a later call never overtakes the holder.
  async function acquire({ waitMs = 5 * 60 * 1000, signal } = {}) {
    const until = Date.now() + waitMs;
    const turn = queue;
    let done;
    queue = new Promise(resolve => { done = resolve; });
    let handle;
    try { signal?.throwIfAborted?.(); await waitFor(turn, until, signal); } catch (error) { turn.then(done, done); throw error; }
    try {
      signal?.throwIfAborted?.();
      const busy = () => Object.assign(new Error('The sandbox store is busy.'), { code: 'store_busy' });
      for (;;) {
        signal?.throwIfAborted?.();
        // The deadline covers the helper call too: it gets only the time that is left, and a grant that
        // arrives after the deadline is given back and refused.
        const left = until - Date.now();
        if (left <= 0) throw busy();
        try { handle = await tryLockAsync(dispatchFile, { signal, timeoutMs: Math.min(ASYNC_WAIT_MS, left) }); } catch (error) {
          if (error?.code === 'lock_unavailable' && Date.now() >= until) throw busy();
          throw error;
        }
        if (handle) {
          if (Date.now() > until) { handle.release(); handle = null; throw busy(); }
          break;
        }
        if (Date.now() >= until) throw busy();
        await delay(pollMs);
      }
    } catch (error) { done(); throw error; }
    let released = false;
    return {
      held: () => !released && handle.held(),
      release() { if (released) return; released = true; try { handle.release(); } finally { done(); } },
    };
  }

  // `fn` runs to completion before the gate is released, however its caller is cancelled:
  // an operation that may still change the store keeps the store fenced until it has ended.
  async function exclusive(fn, options = {}) {
    const gate = await acquire(options);
    try { options.signal?.throwIfAborted?.(); return await fn({ held: gate.held }); } finally { gate.release(); }
  }

  // Held for a whole sweep. Not waited for: a busy store means another sweep is running.
  async function sweep(fn) {
    if (sweeping) return { skipped: 'store_busy' };
    sweeping = true;
    try {
      const handle = await tryLockAsync(sweepFile, {});
      if (!handle) return { skipped: 'store_busy' };
      try { return await fn(); } finally { handle.release(); }
    } finally { sweeping = false; }
  }

  return { acquire, exclusive, sweep, dir };
}
