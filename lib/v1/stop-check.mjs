import {createHash, randomUUID} from 'node:crypto';
import {buildValidatedJobSpec} from '../executor.mjs';
import {getHarnessAdapter} from '../harnesses/index.mjs';
import {STOP_ANSWER_MS} from './lending-probe.mjs';
import {qualifyingStop} from './stop-evidence.mjs';

/**
 * The stop check: the only producer of stop evidence (stop-evidence.mjs).
 *
 * It starts one dedicated guarded sandbox that runs nothing but a marked sleep, then does what the app does to a real job: the
 * guarded Stop (an answer window, then a hard stop), then removal. The receipt is written only when the guard answered inside
 * its window (no hard fallback) and the removal was verified. The measured interval runs from the Stop request to effective
 * cessation, which the backend reports through `onCessation`. It does not include the time the removal takes afterwards.
 *
 * Never evidence: a real job's stop, a hard fallback, an unguarded or already finished run, a run that failed or was cancelled,
 * a thrown stop, an unverified removal, a failed save.
 */
export const STOP_CHECK_MARKER = 'faravan_stop_check';
const READY_LINE = `${STOP_CHECK_MARKER}_ready`;
const RESOURCES = Object.freeze({wall_seconds: 300, cpu: 1, memory_mib: 512, storage_mib: 512, output_bytes: 16 * 1024,
  network_bytes: 1024 * 1024, max_processes: 64});
// Room for the guarded Stop and the removal after the check's own timeout.
const HOLD_MARGIN_MS = 180_000;

export function createStopCheck({backend, store, gate = null, now = Date.now, stopAnswerMs = STOP_ANSWER_MS, timeoutMs = 120_000} = {}) {
  if (!backend || typeof backend.lenderCapabilities !== 'function' || typeof backend.prepare !== 'function' || typeof backend.start !== 'function' ||
      typeof backend.requestStop !== 'function' || typeof backend.destroy !== 'function')
    throw new TypeError('the stop check needs the durable sandbox backend');
  if (!store || typeof store.begin !== 'function') throw new TypeError('the stop check needs a stop evidence store');

  /** The machine's sandbox runtime as the receipt binds it, or null when the backend cannot name it. */
  async function binding({signal} = {}) {
    const capabilities = await backend.lenderCapabilities({signal});
    const version = capabilities?.version ?? capabilities?.preflight?.version;
    if (capabilities?.available !== true || typeof capabilities.backend_id !== 'string' || !capabilities.backend_id || typeof version !== 'string' || !version) return null;
    return {backend_id: capabilities.backend_id, sbx_version: version};
  }

  async function measure(generation, bound, signal) {
    const throwIfAborted = () => { if (signal?.aborted) throw signal.reason ?? new DOMException('The app is closing.', 'AbortError'); };
    const harness = getHarnessAdapter('claude-code-subscription').lendingSpec;
    const spec = buildValidatedJobSpec({taskDigest: createHash('sha256').update(randomUUID()).digest('hex'), harness,
      executionScope: 'borrowed', entrypointWithPrompt: `echo ${READY_LINE} && sleep 300`, network: 'provider-only', resources: RESOURCES});
    let handle = null, run = null, runError = null, stdout = '', timer;
    let readyResolve;
    const ready = new Promise(resolve => { readyResolve = resolve; });
    try {
      handle = await backend.prepare(spec, {signal, providerAccess: false, githubKit: false});
      throwIfAborted();
      // The execution callback selects the backend's generic guard without a provider budget.
      run = backend.start(handle, {onExecutionStarted() {}, onLog(event) {
        if (event?.stream !== 'stdout' || stdout.length >= 4096) return;
        stdout += Buffer.from(event.chunk ?? '').toString('utf8');
        if (stdout.includes(READY_LINE)) readyResolve('ready');
      }}).catch(error => { runError = error; readyResolve('ended'); return null; });
      const timedOut = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs); timer.unref?.(); });
      const aborted = new Promise(resolve => { if (signal?.aborted) resolve('aborted'); else signal?.addEventListener('abort', () => resolve('aborted'), {once: true}); });
      const first = await Promise.race([ready, timedOut, aborted]);
      clearTimeout(timer);
      // Without a running marked guest there is nothing to stop: that is a failed check, never evidence.
      let stopped = null, requestedAt = null, ceasedAt = null;
      if (first === 'ready') {
        requestedAt = now();
        try { stopped = await backend.requestStop(handle, 'owner', {answerMs: stopAnswerMs, onCessation: () => { ceasedAt ??= now(); }}); }
        catch { stopped = {delivered: false, fallback: null}; }
      } else await backend.requestStop(handle, 'owner', {answerMs: stopAnswerMs}).catch(() => null);
      // The run ends with a delivered stop or a hard stop. After any other answer nothing ended it, so removal (not the run) ends it.
      if (run && (stopped?.delivered === true || stopped?.fallback === 'hard')) await run;
      const removal = await backend.destroy(handle);
      handle = null;
      const stop = {delivered: stopped?.delivered === true, fallback: stopped?.fallback ?? null,
        latency_ms: ceasedAt !== null && requestedAt !== null ? Math.max(0, ceasedAt - requestedAt) : NaN, removed: removal?.removed === true};
      const clean = first === 'ready' && !runError && !signal?.aborted && ceasedAt !== null && qualifyingStop(stop);
      return clean ? {ok: true, stop, measured_at: ceasedAt} : {ok: false, reason: first === 'aborted' || signal?.aborted ? 'cancelled'
        : first === 'timeout' ? 'timeout' : removal?.removed !== true ? 'removal_unverified' : stop.fallback === 'hard' ? 'stop_not_delivered' : runError?.code ?? 'stop_check_failed'};
    } catch (error) {
      return {ok: false, reason: signal?.aborted ? 'cancelled' : error?.code === 'daemon_hold_timeout' ? 'timeout' : error?.code ?? 'stop_check_failed'};
    } finally {
      clearTimeout(timer);
      if (handle) {
        await backend.requestStop(handle, 'owner', {answerMs: stopAnswerMs}).catch(() => null);
        await backend.destroy(handle).catch(() => null);
      }
    }
  }

  /**
   * One stop check. Resolves {ok:true, receipt} or {ok:false, reason}. It never throws for a failed check, and it never
   * lets a failed or unsaved check leave an older receipt standing.
   */
  async function check({signal} = {}) {
    let bound;
    try { bound = await binding({signal}); } catch { bound = null; }
    if (!bound) return {ok: false, reason: 'stop_check_unavailable'};
    let generation;
    try { generation = await store.begin(); } catch { return {ok: false, reason: 'stop_check_unrecorded'}; }
    let outcome;
    try {
      outcome = gate
        ? await gate.run(() => measure(generation, bound, signal), {signal, label: 'the stop check', holdMs: timeoutMs + HOLD_MARGIN_MS})
        : await measure(generation, bound, signal);
    } catch (error) {
      outcome = {ok: false, reason: error?.code === 'daemon_hold_timeout' ? 'timeout' : error?.code === 'daemon_busy' ? 'stop_check_unavailable' : signal?.aborted ? 'cancelled' : 'stop_check_failed'};
    }
    if (outcome.ok) {
      const saved = await store.succeed(generation, {...bound, stop: outcome.stop, measured_at: outcome.measured_at});
      if (saved) return {ok: true, receipt: await store.current(bound)};
      await store.fail(generation);
      return {ok: false, reason: 'stop_check_unrecorded'};
    }
    await store.fail(generation);
    return outcome;
  }

  return Object.assign(check, {binding});
}
